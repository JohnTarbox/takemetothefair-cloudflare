/**
 * Homepage "Latest from the Blog" ranking (2026-06-23).
 *
 * Replaces the prior rule — `ORDER BY publish_date DESC LIMIT 3` — which had
 * gone degenerate: the entire 103-post corpus was published in a ~2-month burst
 * and then publishing went quiet, so "the 3 newest" had been a FROZEN, arbitrary
 * set for 18 days. Recency stopped being a ranking signal and became an accidental
 * static pin.
 *
 * This is a pure, weighted scorer over four signals (no DB, no I/O — the SQL in
 * getRecentBlogPosts feeds it normalized inputs; tests exercise it directly):
 *
 *   timeliness  how soon the post's soonest UPCOMING linked event is (content_links
 *               → events). The seasonal-business signal: a Big-E guide is most
 *               valuable while the Big E approaches. 0 when the post links no
 *               upcoming event.
 *   popularity  view_count, log-scaled so one viral post can't dominate the page.
 *   recency     publish-date freshness, decaying over RECENCY_WINDOW_DAYS.
 *   featured    editorial pin — a STRONG additive boost (not a hard override): a
 *               featured post usually wins, but a sufficiently timely + popular +
 *               recent post can still edge it out.
 *
 * Weights below are the only tuning knobs; every factor is normalized to [0,1]
 * first so the weights are directly interpretable as "max contribution."
 */
import { diversifyByCategory } from "@/lib/diversify-by-category";

/** Max contribution of each factor to a post's score. timeliness+popularity+
 *  recency sum to 1.0 (so a non-featured post tops out at 1.0); `featured` is an
 *  additive boost on top — 0.60 means a bare featured post (zero other signal)
 *  scores 0.60, which only a strongly timely+popular+recent post can beat. */
export const RANKING_WEIGHTS = {
  timeliness: 0.45,
  popularity: 0.3,
  recency: 0.25,
  featured: 0.6,
} as const;

/** A linked event this many days out (or more) contributes ~0 timeliness; today
 *  (or in-progress) contributes the full weight. */
export const TIMELINESS_HORIZON_DAYS = 60;
/** Posts older than this contribute ~0 recency. */
export const RECENCY_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

export interface BlogPostRankInput {
  featured: boolean;
  publishDate: Date | null;
  viewCount: number;
  /** Start date of the soonest UPCOMING linked event (an event whose end_date is
   *  still >= now), or null if the post links no upcoming event. Computed by the
   *  content_links → events join in getRecentBlogPosts. */
  soonestUpcomingEventStart: Date | null;
  /** JSON string array — `categories[0]` is the de-dup key, same as the card chip. */
  categories: string | null;
}

export interface RankingContext {
  now: Date;
  /** Pool maximum view_count, for normalizing the popularity factor. */
  maxViewCount: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Timeliness ∈ [0,1]: 1 when the soonest linked upcoming event is today or in
 *  progress, decaying linearly to 0 at TIMELINESS_HORIZON_DAYS out. 0 when there
 *  is no upcoming linked event. */
export function timelinessFactor(soonestUpcomingEventStart: Date | null, now: Date): number {
  if (!soonestUpcomingEventStart) return 0;
  const daysAway = Math.max(0, (soonestUpcomingEventStart.getTime() - now.getTime()) / DAY_MS);
  return clamp01(1 - daysAway / TIMELINESS_HORIZON_DAYS);
}

/** Popularity ∈ [0,1]: log-scaled view_count over the pool max, so the gap from
 *  10→100 views matters as much as 100→1000 (and one outlier can't own the page).
 *  0 when the whole pool has no views. */
export function popularityFactor(viewCount: number, maxViewCount: number): number {
  if (maxViewCount <= 0) return 0;
  return clamp01(Math.log1p(Math.max(0, viewCount)) / Math.log1p(maxViewCount));
}

/** Recency ∈ [0,1]: 1 for a post published now, decaying linearly to 0 at
 *  RECENCY_WINDOW_DAYS old. 0 when unpublished/dateless. */
export function recencyFactor(publishDate: Date | null, now: Date): number {
  if (!publishDate) return 0;
  const ageDays = Math.max(0, (now.getTime() - publishDate.getTime()) / DAY_MS);
  return clamp01(1 - ageDays / RECENCY_WINDOW_DAYS);
}

/** Weighted blog-post score. Non-featured posts ∈ [0,1]; featured posts get
 *  + RANKING_WEIGHTS.featured on top (so ∈ [0.6, 1.6] with defaults). */
export function scoreBlogPost(post: BlogPostRankInput, ctx: RankingContext): number {
  const timeliness = timelinessFactor(post.soonestUpcomingEventStart, ctx.now);
  const popularity = popularityFactor(post.viewCount, ctx.maxViewCount);
  const recency = recencyFactor(post.publishDate, ctx.now);
  return (
    RANKING_WEIGHTS.timeliness * timeliness +
    RANKING_WEIGHTS.popularity * popularity +
    RANKING_WEIGHTS.recency * recency +
    (post.featured ? RANKING_WEIGHTS.featured : 0)
  );
}

/**
 * Rank a pool of published posts and return the top `limit`, de-duplicated by
 * primary category (so the section never shows three same-topic posts). Pure:
 * pass the full row type plus the BlogPostRankInput fields and get the same rows
 * back, ranked + trimmed.
 *
 * Order: score DESC, then publish_date DESC as a stable tiebreak, then category
 * de-dup via the shared diversifyByCategory (one-per-category, backfill by score
 * when too few categories exist to fill the grid).
 */
export function selectHomepageBlogPosts<T extends BlogPostRankInput>(
  posts: T[],
  opts: { now?: Date; limit?: number } = {}
): T[] {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 3;
  if (posts.length === 0) return [];

  const maxViewCount = posts.reduce((m, p) => Math.max(m, p.viewCount ?? 0), 0);
  const ctx: RankingContext = { now, maxViewCount };

  const scored = posts
    .map((post) => ({ post, score: scoreBlogPost(post, ctx) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable, deterministic tiebreak: newer first.
      const at = a.post.publishDate?.getTime() ?? 0;
      const bt = b.post.publishDate?.getTime() ?? 0;
      return bt - at;
    })
    .map((s) => s.post);

  return diversifyByCategory(scored, limit);
}

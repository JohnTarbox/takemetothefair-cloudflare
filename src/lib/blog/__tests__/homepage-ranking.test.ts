import { describe, it, expect } from "vitest";
import {
  RANKING_WEIGHTS,
  TIMELINESS_HORIZON_DAYS,
  RECENCY_WINDOW_DAYS,
  timelinessFactor,
  popularityFactor,
  recencyFactor,
  scoreBlogPost,
  selectHomepageBlogPosts,
  type BlogPostRankInput,
} from "../homepage-ranking";

const NOW = new Date("2026-06-23T12:00:00Z");
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

function post(
  overrides: Partial<BlogPostRankInput> & { categories?: string | null }
): BlogPostRankInput {
  return {
    featured: false,
    publishDate: daysFromNow(-1),
    viewCount: 0,
    soonestUpcomingEventStart: null,
    categories: '["Fair"]',
    ...overrides,
  };
}

describe("timelinessFactor", () => {
  it("is 0 when there is no upcoming linked event", () => {
    expect(timelinessFactor(null, NOW)).toBe(0);
  });

  it("is 1 for an event happening today or in progress (past start, still upcoming)", () => {
    expect(timelinessFactor(NOW, NOW)).toBe(1);
    expect(timelinessFactor(daysFromNow(-3), NOW)).toBe(1); // ongoing → clamped to 1
  });

  it("decays linearly to 0 at the horizon", () => {
    expect(timelinessFactor(daysFromNow(TIMELINESS_HORIZON_DAYS), NOW)).toBeCloseTo(0);
    expect(timelinessFactor(daysFromNow(TIMELINESS_HORIZON_DAYS / 2), NOW)).toBeCloseTo(0.5);
  });

  it("is 0 beyond the horizon (does not go negative)", () => {
    expect(timelinessFactor(daysFromNow(TIMELINESS_HORIZON_DAYS * 2), NOW)).toBe(0);
  });
});

describe("popularityFactor", () => {
  it("is 0 when the pool has no views (no divide-by-zero)", () => {
    expect(popularityFactor(0, 0)).toBe(0);
    expect(popularityFactor(5, 0)).toBe(0);
  });

  it("is 1 at the pool maximum", () => {
    expect(popularityFactor(1000, 1000)).toBeCloseTo(1);
  });

  it("is log-scaled, not linear (10→100 ~ as big a jump as 100→1000)", () => {
    const a = popularityFactor(10, 1000);
    const b = popularityFactor(100, 1000);
    const c = popularityFactor(1000, 1000);
    expect(b - a).toBeCloseTo(c - b, 1);
  });
});

describe("recencyFactor", () => {
  it("is ~1 for a just-published post and 0 for unpublished", () => {
    expect(recencyFactor(NOW, NOW)).toBe(1);
    expect(recencyFactor(null, NOW)).toBe(0);
  });

  it("decays to 0 at the recency window", () => {
    expect(recencyFactor(daysFromNow(-RECENCY_WINDOW_DAYS), NOW)).toBeCloseTo(0);
    expect(recencyFactor(daysFromNow(-RECENCY_WINDOW_DAYS / 2), NOW)).toBeCloseTo(0.5);
  });
});

describe("scoreBlogPost", () => {
  const ctx = { now: NOW, maxViewCount: 100 };

  it("a bare featured post scores exactly the featured weight", () => {
    const s = scoreBlogPost(
      post({ featured: true, publishDate: daysFromNow(-RECENCY_WINDOW_DAYS), viewCount: 0 }),
      ctx
    );
    expect(s).toBeCloseTo(RANKING_WEIGHTS.featured);
  });

  it("featured is a STRONG boost but can be edged out by a standout post", () => {
    const featuredMeh = scoreBlogPost(
      post({ featured: true, publishDate: daysFromNow(-RECENCY_WINDOW_DAYS), viewCount: 0 }),
      ctx
    );
    // A non-featured post that is maximally timely, popular, and fresh.
    const standout = scoreBlogPost(
      post({
        featured: false,
        publishDate: NOW,
        viewCount: 100,
        soonestUpcomingEventStart: NOW,
      }),
      ctx
    );
    expect(standout).toBeGreaterThan(featuredMeh);
  });

  it("featured beats an otherwise-similar non-featured post", () => {
    const base = {
      publishDate: daysFromNow(-10),
      viewCount: 20,
      soonestUpcomingEventStart: daysFromNow(30),
    };
    expect(scoreBlogPost(post({ ...base, featured: true }), ctx)).toBeGreaterThan(
      scoreBlogPost(post({ ...base, featured: false }), ctx)
    );
  });
});

describe("selectHomepageBlogPosts", () => {
  it("returns [] for an empty pool", () => {
    expect(selectHomepageBlogPosts([], { now: NOW })).toEqual([]);
  });

  it("ranks a timely post above a merely newer one", () => {
    const newer = post({ publishDate: NOW, soonestUpcomingEventStart: null, categories: '["A"]' });
    const timely = post({
      publishDate: daysFromNow(-20),
      soonestUpcomingEventStart: daysFromNow(2),
      categories: '["B"]',
    });
    const [first] = selectHomepageBlogPosts([newer, timely], { now: NOW, limit: 2 });
    expect(first).toBe(timely);
  });

  it("de-dups by primary category, then backfills by score", () => {
    // Three Fair posts (descending score) + one Music post. Top-3 should not be
    // all-Fair: the Music post displaces the 3rd Fair post.
    const fairTop = post({ featured: true, categories: '["Fair"]' });
    const fairMid = post({ viewCount: 100, categories: '["Fair"]' });
    const fairLow = post({ publishDate: daysFromNow(-2), categories: '["Fair"]' });
    const music = post({ soonestUpcomingEventStart: daysFromNow(5), categories: '["Music"]' });

    const picked = selectHomepageBlogPosts([fairTop, fairMid, fairLow, music], {
      now: NOW,
      limit: 3,
    });
    expect(picked).toContain(fairTop);
    expect(picked).toContain(music);
    expect(picked).not.toContain(fairLow); // displaced by category de-dup
    expect(picked).toHaveLength(3);
  });

  it("honors the limit", () => {
    const pool = [
      post({ categories: '["A"]' }),
      post({ categories: '["B"]' }),
      post({ categories: '["C"]' }),
    ];
    expect(selectHomepageBlogPosts(pool, { now: NOW, limit: 2 })).toHaveLength(2);
  });
});

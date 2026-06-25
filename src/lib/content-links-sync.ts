import { and, eq, inArray, isNull } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { contentLinks, events, blogPosts, promoters, users } from "@/lib/db/schema";
import {
  CONTENT_LINK_INARRAY_CHUNK,
  extractContentLinks,
  resolveContentLinkTargetIds,
  type ContentLinkRef,
  type ContentLinkTargetType,
} from "@/lib/blog-links";
import { getSiteUrl } from "@/lib/email/send";
import { enqueueEmail } from "@/lib/queues/producers";
import { promoterBlogMentionTemplate } from "@/lib/email/templates";
import { logError } from "@/lib/logger";

export interface SyncResult {
  /** Links newly inserted by this sync pass. */
  added: Array<ContentLinkRef & { targetId: string | null }>;
  /** Links removed by this sync pass. */
  removed: Array<ContentLinkRef & { targetId: string | null }>;
  /** The final link set after sync. */
  current: Array<ContentLinkRef & { targetId: string | null }>;
  /** How many promoter emails were fired (stub or real). */
  notified: number;
}

/**
 * Opt-in notification behaviour. Callers that don't care about notifications
 * (backfill, tests) pass `{ notify: false }` or simply omit the option.
 *
 * The runtime cost of the notification path is the status fetch + one promoter
 * join + one email per new EVENT link for PUBLISHED posts. Unchanged bodies
 * compute zero diffs and skip the whole path.
 */
export interface SyncOptions {
  /** Whether to fire promoter blog-mention emails for new EVENT links. */
  notify?: boolean;
  /**
   * Slug of the blog post being synced. When provided, any extracted
   * `/blog/<sourceSlug>` reference (a self-link) is filtered out before
   * writing to content_links. Callers that already know the post's slug
   * (the standard write path, plus the reconciliation endpoint) should
   * pass it; older callers that don't will simply not get the self-link
   * filter applied — a self-link row is harmless (resolved to its own
   * id) but is noise in coverage stats.
   */
  sourceSlug?: string;
}

/**
 * Re-derive the content-link index rows for a blog post from its body and
 * apply the diff. Idempotent: calling twice with the same body is a no-op.
 *
 * - source_type is always BLOG_POST here (add overloads if we ever index
 *   non-blog sources).
 * - Broken slugs (no matching event/vendor/venue row) are still stored with
 *   target_id = NULL so the broken-link warning surface still sees them.
 * - Does not throw on DB errors — the caller is responsible for logging;
 *   a failed sync must not prevent the blog post save from succeeding.
 */
export async function syncContentLinks(
  db: ReturnType<typeof getCloudflareDb>,
  blogPostId: string,
  body: string | null | undefined,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  // Filter self-links at the extract boundary so they never enter the
  // sync diff. A blog post referencing its own /blog/<slug> URL would
  // otherwise produce a row pointing at itself, which is noise in
  // coverage stats and a footgun for any future "what does this link
  // to" query that doesn't bother to exclude self-edges.
  const rawReferenced = extractContentLinks(body);
  const referenced = opts.sourceSlug
    ? rawReferenced.filter(
        (r) => !(r.targetType === "BLOG_POST" && r.targetSlug === opts.sourceSlug)
      )
    : rawReferenced;

  // Resolve slugs → ids. Chunked under D1's bound-param cap (K42) and
  // event_slug_history-aware so a body link to a renamed event still
  // resolves (K45) instead of being stored as a dangling null.
  const targetIdsByTypeSlug = await resolveContentLinkTargetIds(db, referenced);

  const referencedWithIds = referenced.map((r) => ({
    ...r,
    targetId: targetIdsByTypeSlug.get(`${r.targetType}|${r.targetSlug.toLowerCase()}`) ?? null,
  }));

  // Load existing rows for this source.
  const existing = await db
    .select({
      id: contentLinks.id,
      targetType: contentLinks.targetType,
      targetSlug: contentLinks.targetSlug,
      targetId: contentLinks.targetId,
    })
    .from(contentLinks)
    .where(and(eq(contentLinks.sourceType, "BLOG_POST"), eq(contentLinks.sourceId, blogPostId)));

  const existingKey = (r: { targetType: string; targetSlug: string }) =>
    `${r.targetType}|${r.targetSlug}`;
  const refSet = new Set(referenced.map(existingKey));
  const existSet = new Set(existing.map(existingKey));

  const toInsert = referencedWithIds.filter((r) => !existSet.has(existingKey(r)));
  const toDelete = existing.filter((r) => !refSet.has(existingKey(r)));

  // A2/K45 — existing rows still present in the body but stored with a NULL
  // target_id (the target didn't exist at the original save time, or its slug
  // has since moved into event_slug_history). If they resolve now, patch the
  // id in place. Without this the link stayed broken until the SOURCE post was
  // manually re-saved (the strawberry-guide → pillar and Bar Harbor cases).
  const toUpdate: Array<{ id: string; targetId: string }> = [];
  for (const r of existing) {
    if (r.targetId !== null) continue;
    const key = `${r.targetType}|${r.targetSlug.toLowerCase()}`;
    if (!refSet.has(existingKey(r))) continue; // headed for deletion instead
    const resolvedId = targetIdsByTypeSlug.get(key);
    if (resolvedId) toUpdate.push({ id: r.id, targetId: resolvedId });
  }

  if (toInsert.length > 0) {
    // D1 caps each statement at 100 bound parameters. content_links has 8
    // columns (id and createdAt come from $defaultFn but Drizzle still emits
    // them), so chunks are capped at 12 rows (12 × 8 = 96). A long blog post
    // referencing 20+ entities used to silently throw "too many SQL variables"
    // here — same root cause as the event_days data-loss bug.
    const rows = toInsert.map((r) => ({
      sourceType: "BLOG_POST" as const,
      sourceId: blogPostId,
      targetType: r.targetType as ContentLinkTargetType,
      targetSlug: r.targetSlug,
      targetId: r.targetId,
    }));
    const CONTENT_LINKS_CHUNK_SIZE = 12;
    for (let i = 0; i < rows.length; i += CONTENT_LINKS_CHUNK_SIZE) {
      await db.insert(contentLinks).values(rows.slice(i, i + CONTENT_LINKS_CHUNK_SIZE));
    }
  }

  // Re-resolve previously-null rows in place (A2/K45).
  for (const u of toUpdate) {
    await db.update(contentLinks).set({ targetId: u.targetId }).where(eq(contentLinks.id, u.id));
  }

  if (toDelete.length > 0) {
    // Chunk the id list under D1's 100 bound-param cap — a post that shed many
    // links in one edit could otherwise blow the cap here (K42, delete side).
    const ids = toDelete.map((r) => r.id);
    for (let i = 0; i < ids.length; i += CONTENT_LINK_INARRAY_CHUNK) {
      await db
        .delete(contentLinks)
        .where(inArray(contentLinks.id, ids.slice(i, i + CONTENT_LINK_INARRAY_CHUNK)));
    }
  }

  let notified = 0;
  if (opts.notify) {
    try {
      notified = await fireBlogMentionNotifications(db, blogPostId);
    } catch (err) {
      await logError(db, {
        level: "warn",
        message: "Blog mention notification dispatch failed",
        error: err,
        source: "content-links-sync:notify",
        context: { blogPostId },
      });
    }
  }

  return {
    added: toInsert.map((r) => ({
      targetType: r.targetType,
      targetSlug: r.targetSlug,
      targetId: r.targetId,
    })),
    removed: toDelete.map((r) => ({
      targetType: r.targetType as ContentLinkTargetType,
      targetSlug: r.targetSlug,
      targetId: r.targetId,
    })),
    current: referencedWithIds,
    notified,
  };
}

const SLUG_PATH_BY_TYPE: Record<ContentLinkTargetType, string> = {
  EVENT: "events",
  VENDOR: "vendors",
  VENUE: "venues",
  BLOG_POST: "blog",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A3.3 / K43 — slug-change auto-repair hook.
 *
 * When an entity's slug changes (event admin edit, merge, EH3
 * series-occurrence canonicalization), every blog body that links to the OLD
 * slug keeps pointing at a URL that now only 301-redirects. `resolveContent
 * LinkTargetIds` already keeps such a link from being flagged broken (via
 * `event_slug_history`), but the body still carries the stale slug, and each
 * future canonical change would quietly add another layer of redirect. This
 * rewrites the slug in the body to the new canonical and re-syncs the index,
 * so inbound blog links track the entity's current URL with no manual edit.
 *
 * Idempotent and boundary-safe: `/events/big-e` is rewritten, `/events/
 * big-e-2026` is not. No-op when oldSlug === newSlug or nothing links to it.
 * Each post is independent — a failure on one is logged and skipped, never
 * thrown, so a slug rename never fails on link-repair.
 */
export async function repairBlogLinksForSlugChange(
  db: ReturnType<typeof getCloudflareDb>,
  targetType: ContentLinkTargetType,
  oldSlug: string,
  newSlug: string
): Promise<{ postsUpdated: number; linksRewritten: number }> {
  if (!oldSlug || !newSlug || oldSlug === newSlug) {
    return { postsUpdated: 0, linksRewritten: 0 };
  }
  const path = SLUG_PATH_BY_TYPE[targetType];

  // Which blog posts link to the old slug? Read it off the content_links index
  // (kept fresh by syncContentLinks) rather than scanning every body.
  const rows = await db
    .select({ sourceId: contentLinks.sourceId })
    .from(contentLinks)
    .where(
      and(
        eq(contentLinks.sourceType, "BLOG_POST"),
        eq(contentLinks.targetType, targetType),
        eq(contentLinks.targetSlug, oldSlug.toLowerCase())
      )
    );
  const postIds = Array.from(new Set(rows.map((r) => r.sourceId)));
  if (postIds.length === 0) return { postsUpdated: 0, linksRewritten: 0 };

  const linkRe = new RegExp(`/${path}/${escapeRegExp(oldSlug)}(?=[^a-z0-9-]|$)`, "gi");
  const replacement = `/${path}/${newSlug}`;

  let postsUpdated = 0;
  let linksRewritten = 0;
  for (let i = 0; i < postIds.length; i += CONTENT_LINK_INARRAY_CHUNK) {
    const chunk = postIds.slice(i, i + CONTENT_LINK_INARRAY_CHUNK);
    const posts = await db
      .select({ id: blogPosts.id, slug: blogPosts.slug, body: blogPosts.body })
      .from(blogPosts)
      .where(inArray(blogPosts.id, chunk));
    for (const post of posts) {
      if (!post.body) continue;
      const matches = post.body.match(linkRe);
      if (!matches || matches.length === 0) continue;
      const newBody = post.body.replace(linkRe, replacement);
      if (newBody === post.body) continue;
      try {
        await db
          .update(blogPosts)
          .set({ body: newBody, updatedAt: new Date() })
          .where(eq(blogPosts.id, post.id));
        // Re-sync so the content_links rows pick up the new slug + resolved id.
        await syncContentLinks(db, post.id, newBody, { notify: false, sourceSlug: post.slug });
        postsUpdated++;
        linksRewritten += matches.length;
      } catch (err) {
        await logError(db, {
          level: "warn",
          message: "Blog link slug-change repair failed for post",
          error: err,
          source: "content-links-sync:repair-slug-change",
          context: { postId: post.id, targetType, oldSlug, newSlug },
        });
      }
    }
  }

  return { postsUpdated, linksRewritten };
}

/**
 * Dispatch blog-mention emails for every unnotified EVENT link on a PUBLISHED
 * blog post. Stamps `notified_at` on success (stub or real provider).
 *
 * Why select-then-filter instead of a single JOIN-heavy query: we need the
 * resolved event+promoter+contact-email rows for the email body anyway, and
 * the selection step is small (usually 0–3 rows per post). Keeps the firing
 * code linear and easy to audit.
 */
async function fireBlogMentionNotifications(
  db: ReturnType<typeof getCloudflareDb>,
  blogPostId: string
): Promise<number> {
  // Only fire for PUBLISHED posts. Catch the status at dispatch time — a
  // DRAFT→PUBLISHED transition with a prior-saved link row should still fire.
  const [post] = await db
    .select({
      id: blogPosts.id,
      slug: blogPosts.slug,
      title: blogPosts.title,
      status: blogPosts.status,
    })
    .from(blogPosts)
    .where(eq(blogPosts.id, blogPostId))
    .limit(1);
  if (!post || post.status !== "PUBLISHED") return 0;

  // Unnotified EVENT links for this post, joined up to the promoter's
  // contact_email (falls back to the linked user's email).
  const rows = await db
    .select({
      linkId: contentLinks.id,
      eventId: events.id,
      eventName: events.name,
      eventSlug: events.slug,
      promoterName: promoters.companyName,
      promoterContactEmail: promoters.contactEmail,
      userEmail: users.email,
    })
    .from(contentLinks)
    .innerJoin(events, eq(contentLinks.targetId, events.id))
    .innerJoin(promoters, eq(events.promoterId, promoters.id))
    .leftJoin(users, eq(promoters.userId, users.id))
    .where(
      and(
        eq(contentLinks.sourceType, "BLOG_POST"),
        eq(contentLinks.sourceId, blogPostId),
        eq(contentLinks.targetType, "EVENT"),
        isNull(contentLinks.notifiedAt)
      )
    );

  if (rows.length === 0) return 0;

  const siteUrl = getSiteUrl();
  let fired = 0;

  for (const r of rows) {
    const to = r.promoterContactEmail || r.userEmail;
    if (!to) continue;

    const { subject, html, text } = promoterBlogMentionTemplate({
      promoterName: r.promoterName ?? null,
      postTitle: post.title,
      postUrl: `${siteUrl}/blog/${post.slug}`,
      eventName: r.eventName,
      eventUrl: `${siteUrl}/events/${r.eventSlug}`,
    });

    // Enqueue rather than direct-send. The queue consumer delivers via
    // CF Email Sending with built-in retries; on a transient failure
    // the message stays in flight rather than silently dropping. Stamp
    // notified_at on enqueue success — the link row only re-fires if
    // explicitly unstamped or the message is replayed from DLQ.
    try {
      await enqueueEmail({
        to,
        subject,
        html,
        text,
        source: "content-links-sync.promoter-mention",
      });
    } catch {
      continue;
    }

    await db
      .update(contentLinks)
      .set({ notifiedAt: new Date() })
      .where(eq(contentLinks.id, r.linkId));
    fired++;
  }

  return fired;
}

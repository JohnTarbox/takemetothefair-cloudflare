import { and, eq, inArray, isNull } from "drizzle-orm";
import type { getCloudflareDb } from "@/lib/cloudflare";
import {
  contentLinks,
  events,
  vendors,
  venues,
  blogPosts,
  promoters,
  users,
} from "@/lib/db/schema";
import {
  extractContentLinks,
  type ContentLinkRef,
  type ContentLinkTargetType,
} from "@/lib/blog-links";
import { sendEmail, getSiteUrl } from "@/lib/email/send";
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
  const referenced = extractContentLinks(body);

  // Resolve slugs → ids in one query per entity type.
  const targetIdsByTypeSlug = new Map<string, string>(); // "TYPE|slug" → id
  await Promise.all(
    (["EVENT", "VENDOR", "VENUE"] as const).map(async (type) => {
      const slugs = referenced.filter((r) => r.targetType === type).map((r) => r.targetSlug);
      if (slugs.length === 0) return;
      const table = type === "EVENT" ? events : type === "VENDOR" ? vendors : venues;
      const rows = await db
        .select({ id: table.id, slug: table.slug })
        .from(table)
        .where(inArray(table.slug, slugs));
      for (const r of rows) {
        targetIdsByTypeSlug.set(`${type}|${r.slug.toLowerCase()}`, r.id);
      }
    })
  );

  const referencedWithIds = referenced.map((r) => ({
    ...r,
    targetId: targetIdsByTypeSlug.get(`${r.targetType}|${r.targetSlug}`) ?? null,
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

  if (toInsert.length > 0) {
    await db.insert(contentLinks).values(
      toInsert.map((r) => ({
        sourceType: "BLOG_POST" as const,
        sourceId: blogPostId,
        targetType: r.targetType as ContentLinkTargetType,
        targetSlug: r.targetSlug,
        targetId: r.targetId,
      }))
    );
  }

  if (toDelete.length > 0) {
    await db.delete(contentLinks).where(
      inArray(
        contentLinks.id,
        toDelete.map((r) => r.id)
      )
    );
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

    const result = await sendEmail(db, { to, subject, html, text });
    if (!result.ok) continue;

    await db
      .update(contentLinks)
      .set({ notifiedAt: new Date() })
      .where(eq(contentLinks.id, r.linkId));
    fired++;
  }

  return fired;
}

export const dynamic = "force-dynamic";
/**
 * Reconciliation endpoint for the `content_links` index.
 *
 * Why this exists: content_links rows are normally written by
 * `update_blog_post` via `syncContentLinks()`. Any blog body that's been
 * changed through a different route (direct D1 edits, migrations, bulk
 * SQL fixes) leaves the table stale, and posts that predate the table
 * (created before migration 0031) have no rows at all. The analyst had
 * to rebuild by hand in SQL on 2026-05-24 — 65 stale rows corrected,
 * 103 links backfilled across 32 untracked posts. This endpoint makes
 * that an idempotent admin call.
 *
 * What it does (in order):
 *   1. **Orphan sweep**: delete any content_links row whose source_id
 *      no longer matches a live blog_posts.id. Catches the
 *      Paradise-City-style "deleted post left orphan rows" case for
 *      posts deleted before the cascade-delete fix in this same PR.
 *   2. **Re-sync**: iterate blog posts (id-ordered for stable
 *      pagination) and call `syncContentLinks()` for each, with the
 *      post's slug so self-links are filtered. Idempotent: posts whose
 *      current row set already matches their body produce zero diffs.
 *      `notify: false` to avoid blasting promoter emails on backfill.
 *
 * Pagination: each call processes up to BATCH_SIZE posts. If more
 * remain, `has_more: true` is returned with a `next_cursor` (the last
 * processed id). Pass it back in the next request as `cursor` to
 * continue. Without paging, a ~hundreds-of-posts site would still
 * complete in one call inside Cloudflare's 30s function budget; the
 * cursor is insurance.
 *
 * Auth: admin session OR X-Internal-Key (so the MCP server / cron can
 * fire it). Mirrors the sweep-purge-deleted pattern.
 */
import { NextResponse } from "next/server";
import { and, asc, eq, gt, notInArray, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, contentLinks } from "@/lib/db/schema";
import { syncContentLinks } from "@/lib/content-links-sync";
import { logError } from "@/lib/logger";

const BATCH_SIZE = 50;
const HARD_CAP = 200;

interface PostError {
  id: string;
  slug: string;
  error: string;
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();

  // Parse optional body — { cursor?, limit?, slug? }. A `slug` argument
  // rebuilds exactly one post and skips the orphan sweep, useful for
  // narrow debugging.
  let body: { cursor?: unknown; limit?: unknown; slug?: unknown } = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      body = (await request.json()) as typeof body;
    }
  } catch {
    // Empty body or invalid JSON — treated as default options.
  }

  const cursor = typeof body.cursor === "string" ? body.cursor : null;
  const limit = Math.min(
    typeof body.limit === "number" && body.limit > 0 ? body.limit : BATCH_SIZE,
    HARD_CAP
  );
  const singleSlug = typeof body.slug === "string" && body.slug.length > 0 ? body.slug : null;

  try {
    // ── Single-post mode ─────────────────────────────────────────
    if (singleSlug) {
      const [post] = await db
        .select({ id: blogPosts.id, slug: blogPosts.slug, body: blogPosts.body })
        .from(blogPosts)
        .where(eq(blogPosts.slug, singleSlug as never))
        .limit(1);
      if (!post) {
        return NextResponse.json(
          { error: "Blog post not found", slug: singleSlug },
          { status: 404 }
        );
      }
      const result = await syncContentLinks(db, post.id, post.body, {
        notify: false,
        sourceSlug: post.slug,
      });
      return NextResponse.json({
        success: true,
        mode: "single",
        slug: post.slug,
        added: result.added.length,
        removed: result.removed.length,
        final_links: result.current.length,
      });
    }

    // ── Bulk mode ────────────────────────────────────────────────

    // 1. Orphan sweep — only on the FIRST call (no cursor). Without
    // this we'd reprocess orphans repeatedly across paged calls.
    let orphansPurged = 0;
    if (!cursor) {
      // D1-safe: NOT IN (SELECT id FROM blog_posts) as a SUBQUERY rather than
      // fetching every blog_posts id and binding them via notInArray(array),
      // which blows D1's ~100 bound-variable limit once the blog grows (the
      // /api/admin/users crash class, 2026-06-11). blog_posts.id is the PK
      // (never null), so no isNotNull filter is needed. If there are zero blog
      // posts the subquery purges all BLOG_POST links — correct, they're all
      // orphans then.
      const deleted = await db
        .delete(contentLinks)
        .where(
          and(
            eq(contentLinks.sourceType, "BLOG_POST"),
            notInArray(contentLinks.sourceId, db.select({ id: blogPosts.id }).from(blogPosts))
          )
        )
        .returning({ id: contentLinks.id });
      orphansPurged = deleted.length;
    }

    // 2. Page through blog posts, syncing each.
    const conditions = cursor ? [gt(blogPosts.id, cursor)] : [];
    const posts = await db
      .select({ id: blogPosts.id, slug: blogPosts.slug, body: blogPosts.body })
      .from(blogPosts)
      .where(conditions.length > 0 ? and(...conditions) : sql`1=1`)
      .orderBy(asc(blogPosts.id))
      .limit(limit + 1);

    const hasMore = posts.length > limit;
    const toProcess = hasMore ? posts.slice(0, limit) : posts;

    let added = 0;
    let removed = 0;
    const errors: PostError[] = [];

    for (const post of toProcess) {
      try {
        const result = await syncContentLinks(db, post.id, post.body, {
          notify: false,
          sourceSlug: post.slug,
        });
        added += result.added.length;
        removed += result.removed.length;
      } catch (e) {
        // One bad post shouldn't abort the whole pass. Record and move
        // on — the caller sees the error list in the response.
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ id: post.id, slug: post.slug, error: msg });
        await logError(db, {
          level: "warn",
          source: "api/admin/content-links/rebuild",
          message: "syncContentLinks threw for blog post during rebuild",
          error: e,
          context: { postId: post.id, slug: post.slug },
        });
      }
    }

    const nextCursor = hasMore ? toProcess[toProcess.length - 1].id : null;

    return NextResponse.json({
      success: true,
      mode: "bulk",
      processed: toProcess.length,
      added,
      removed,
      orphans_purged: orphansPurged,
      errors,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  } catch (e) {
    await logError(db, {
      source: "api/admin/content-links/rebuild",
      message: "rebuild threw unexpected exception",
      error: e,
    });
    return NextResponse.json(
      { error: "rebuild_failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}

export const dynamic = "force-dynamic";
/**
 * OPE-1684 — repoint internal links from one blog slug to another, server-side.
 *
 * After `update_blog_post(new_slug)` moves a post, every other post that links
 * the OLD slug keeps working through the blog_slug_history 301, but each of
 * those links is a redirect hop until its body is edited. Before this, the only
 * way to repoint them was resending each post's whole body through the MCP.
 *
 * This wraps `repairBlogLinksForSlugChange` (the same boundary-safe rewrite the
 * event slug-change path uses) with a dry run and guards:
 *  - `toSlug` must be a blog post's CURRENT slug, so the rewrite can never
 *    create a broken link;
 *  - `fromSlug` must NOT be a current post's slug, so a live post's inbound
 *    links are never moved away from it by a typo.
 * Only link targets change (`/blog/<from>` incl. absolute URLs and any
 * ?query / #fragment); each touched post's updated_at moves like any edit and
 * its content_links rows are re-derived. Status and every other field are
 * untouched. `dryRun` (the default) writes nothing.
 *
 * Auth: admin session OR X-Internal-Key. Body: { fromSlug, toSlug, dryRun? }.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts, blogSlugHistory } from "@/lib/db/schema";
import { repairBlogLinksForSlugChange } from "@/lib/content-links-sync";
import { unsafeSlug } from "@/lib/utils";
import { logError } from "@/lib/logger";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { fromSlug?: unknown; toSlug?: unknown; dryRun?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const fromSlug = typeof body.fromSlug === "string" ? body.fromSlug.trim().toLowerCase() : "";
  const toSlug = typeof body.toSlug === "string" ? body.toSlug.trim().toLowerCase() : "";
  const dryRun = body.dryRun !== false;
  if (!SLUG_RE.test(fromSlug) || !SLUG_RE.test(toSlug)) {
    return NextResponse.json(
      { error: "fromSlug and toSlug must be blog slugs (lowercase, hyphenated)" },
      { status: 400 }
    );
  }
  if (fromSlug === toSlug) {
    return NextResponse.json({ error: "fromSlug and toSlug are the same" }, { status: 400 });
  }

  const db = getCloudflareDb();
  try {
    const [target] = await db
      .select({ id: blogPosts.id, slug: blogPosts.slug, status: blogPosts.status })
      .from(blogPosts)
      .where(eq(blogPosts.slug, unsafeSlug(toSlug)))
      .limit(1);
    if (!target) {
      return NextResponse.json(
        {
          error: "to_slug_not_found",
          message: `No blog post has the slug "${toSlug}" — repointing to it would create broken links.`,
        },
        { status: 404 }
      );
    }
    const [live] = await db
      .select({ id: blogPosts.id })
      .from(blogPosts)
      .where(eq(blogPosts.slug, unsafeSlug(fromSlug)))
      .limit(1);
    if (live) {
      return NextResponse.json(
        {
          error: "from_slug_is_live",
          message: `"${fromSlug}" is a live blog post's current slug; its links are not stale. Rename it first (update_blog_post new_slug), then repoint.`,
        },
        { status: 409 }
      );
    }
    const history = await db
      .select({ newSlug: blogSlugHistory.newSlug, blogPostId: blogSlugHistory.blogPostId })
      .from(blogSlugHistory)
      .where(eq(blogSlugHistory.oldSlug, unsafeSlug(fromSlug)));

    const result = await repairBlogLinksForSlugChange(db, "BLOG_POST", fromSlug, toSlug, {
      dryRun,
    });
    return NextResponse.json({
      success: true,
      dryRun,
      fromSlug,
      toSlug,
      target: { id: target.id, status: target.status },
      // Informational: whether the old slug's 301 lands on the same post. A
      // mismatch is not refused (an older chain can be repointed to the head),
      // but it is worth reading before a real run.
      redirectOnRecord: history.some((h) => h.blogPostId === target.id),
      postsPlanned: result.posts.filter((p) => !p.error).length,
      postsUpdated: result.postsUpdated,
      linksRewritten: result.linksRewritten,
      errors: result.posts.filter((p) => p.error).length,
      posts: result.posts,
    });
  } catch (e) {
    await logError(db, {
      source: "api/admin/blog-posts/repoint-links",
      message: "repoint-links threw",
      error: e,
      context: { fromSlug, toSlug, dryRun },
    });
    return NextResponse.json(
      { error: "repoint_failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}

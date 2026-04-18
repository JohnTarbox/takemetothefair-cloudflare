import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts } from "@/lib/db/schema";
import { syncContentLinks } from "@/lib/content-links-sync";
import { logError } from "@/lib/logger";

export const runtime = "edge";

/**
 * Admin-only: iterate every blog post and re-derive its content-link index.
 *
 * Safe to run repeatedly — syncContentLinks is idempotent for unchanged
 * bodies. Runs sequentially rather than in parallel because Cloudflare D1
 * serializes writes anyway and parallel fetches would just queue.
 *
 * Response:
 *   { ok, postCount, totalLinks, addedTotal, removedTotal, failures }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();

  try {
    const posts = await db
      .select({ id: blogPosts.id, slug: blogPosts.slug, body: blogPosts.body })
      .from(blogPosts);

    let totalLinks = 0;
    let addedTotal = 0;
    let removedTotal = 0;
    const failures: Array<{ slug: string; error: string }> = [];

    for (const post of posts) {
      try {
        const result = await syncContentLinks(db, post.id, post.body);
        totalLinks += result.current.length;
        addedTotal += result.added.length;
        removedTotal += result.removed.length;
      } catch (err) {
        failures.push({
          slug: post.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      postCount: posts.length,
      totalLinks,
      addedTotal,
      removedTotal,
      failures,
    });
  } catch (error) {
    await logError(db, {
      message: "Content-link backfill failed",
      error,
      source: "api/admin/content-links/backfill",
      request,
    });
    return NextResponse.json({ error: "Backfill failed" }, { status: 500 });
  }
}

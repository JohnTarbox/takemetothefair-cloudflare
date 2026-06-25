export const dynamic = "force-dynamic";
/**
 * A3.2 / K43 — nightly blog-link integrity audit.
 *
 * Sweeps every PUBLISHED blog post, extracts its internal /events,
 * /vendors, /venues, /blog links, and reports any that don't resolve to a
 * live entity (or an `event_slug_history` redirect). Drift — a dead
 * `/events/<slug>` left behind by a rename/merge/EH3-canonicalize that the
 * auto-repair hook somehow missed — is then caught in a day instead of
 * months. Fired nightly by the MCP Worker cron via `runMainAppSweep`.
 *
 * Resolution is done ONCE across the union of all referenced slugs (chunked
 * under D1's bound-param cap), not per-post, so the sweep is a handful of
 * queries regardless of corpus size.
 *
 * When unresolved links exist, an `error_logs` warn row is written (source
 * `content-links:nightly-audit`) so the existing standing-failure / page-error
 * canaries alert on it without a new dispatch path.
 *
 * Auth: admin session OR X-Internal-Key.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { blogPosts } from "@/lib/db/schema";
import {
  extractContentLinks,
  resolveContentLinkTargetIds,
  type ContentLinkRef,
} from "@/lib/blog-links";
import { logError } from "@/lib/logger";

interface PostDrift {
  slug: string;
  unresolved: ContentLinkRef[];
}

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getCloudflareDb();
  try {
    const posts = await db
      .select({ slug: blogPosts.slug, body: blogPosts.body })
      .from(blogPosts)
      .where(eq(blogPosts.status, "PUBLISHED"));

    // Union of every referenced ref, deduped by TYPE|slug, plus a per-post map
    // so we can attribute unresolved refs back to their post for the report.
    const allRefs = new Map<string, ContentLinkRef>();
    const refsByPost: Array<{ slug: string; refs: ContentLinkRef[] }> = [];
    for (const post of posts) {
      const refs = extractContentLinks(post.body);
      if (refs.length === 0) continue;
      refsByPost.push({ slug: post.slug, refs });
      for (const r of refs) allRefs.set(`${r.targetType}|${r.targetSlug}`, r);
    }

    const resolved = await resolveContentLinkTargetIds(db, Array.from(allRefs.values()));

    const drift: PostDrift[] = [];
    let unresolvedTotal = 0;
    for (const { slug, refs } of refsByPost) {
      const unresolved = refs.filter((r) => !resolved.has(`${r.targetType}|${r.targetSlug}`));
      if (unresolved.length > 0) {
        drift.push({ slug, unresolved });
        unresolvedTotal += unresolved.length;
      }
    }

    if (unresolvedTotal > 0) {
      await logError(db, {
        level: "warn",
        source: "content-links:nightly-audit",
        message: `Blog-link audit found ${unresolvedTotal} unresolved internal link(s) across ${drift.length} post(s)`,
        context: { unresolvedTotal, postsAffected: drift.length, drift: drift.slice(0, 50) },
      });
    }

    return NextResponse.json({
      success: true,
      posts_scanned: posts.length,
      posts_affected: drift.length,
      unresolved_total: unresolvedTotal,
      drift,
    });
  } catch (e) {
    await logError(db, {
      source: "api/admin/content-links/audit",
      message: "blog-link audit threw",
      error: e,
    });
    return NextResponse.json(
      { error: "audit_failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}

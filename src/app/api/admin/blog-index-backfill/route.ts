export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { asc, count, eq } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { blogPosts, gscInspectionState, bingInspectionState } from "@/lib/db/schema";
import { SITE_URL } from "@takemetothefair/constants";
import { inspectUrl, type ScEnv } from "@/lib/search-console";
import { getUrlInfo, type BingEnv } from "@/lib/bing-webmaster";

/**
 * OPE-94 — one-shot blog index-status backfill.
 *
 * Seeds ALL published blog URLs into BOTH `gsc_inspection_state` and
 * `bing_inspection_state` (keyed on the canonical `${HOST}/blog/${slug}`) in a
 * couple of minutes, instead of waiting ~12 days for the daily
 * gsc/bing inspection sweeps to drip ~10 URLs/run.
 *
 * Reuses OPE-91's per-URL inspection primitives: `inspectUrl` (GSC URL
 * Inspection) and `getUrlInfo` (Bing GetUrlInfo), upserting each with the same
 * shape as `runSweep`/`runBingSweep`. The operator button walks this endpoint
 * in bounded chunks, following `nextCursor` until `done`.
 *
 * Worker time is the only constraint: each URL is one GSC call (~3-5s) + one
 * Bing call, so we process a small chunk per request (default 15, cap 25) and
 * let the client paginate. GSC's ~2000/day quota + Bing's quota easily cover
 * the ~113 published posts.
 */

const HOST = SITE_URL;
const DEFAULT_CHUNK = 15;
const MAX_CHUNK = 25;

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const cursor = Math.max(0, parseInt(url.searchParams.get("cursor") || "0", 10) || 0);
    const chunk = Math.min(
      Math.max(
        1,
        parseInt(url.searchParams.get("chunk") || String(DEFAULT_CHUNK), 10) || DEFAULT_CHUNK
      ),
      MAX_CHUNK
    );

    const env = getCloudflareEnv() as unknown as ScEnv & BingEnv;
    const db = getCloudflareDb();

    const [{ total }] = await db
      .select({ total: count() })
      .from(blogPosts)
      .where(eq(blogPosts.status, "PUBLISHED"));

    // Stable cursor: ordered by slug, limit(chunk) offset(cursor). We never
    // mutate blog status during the run, so the ordered set is stable across
    // chunks.
    const posts = await db
      .select({ slug: blogPosts.slug })
      .from(blogPosts)
      .where(eq(blogPosts.status, "PUBLISHED"))
      .orderBy(asc(blogPosts.slug))
      .limit(chunk)
      .offset(cursor);

    const now = new Date();
    let errors = 0;

    for (const post of posts) {
      // Per-URL try/catch: one failed inspection (transient 5xx, quota, parse)
      // must not abort the rest of the chunk — just count it and move on.
      const path = `/blog/${post.slug}`;
      const fullUrl = `${HOST}${path}`;
      try {
        // Google URL Inspection → gsc_inspection_state (same upsert as runSweep).
        const inspection = await inspectUrl(env, path);
        const verdict = inspection.index.verdict ?? "UNKNOWN";
        const coverage = inspection.index.coverageState ?? null;
        await db
          .insert(gscInspectionState)
          .values({
            url: fullUrl,
            lastInspectedAt: now,
            lastVerdict: verdict,
            lastCoverageState: coverage,
            source: "sitemap",
          })
          .onConflictDoUpdate({
            target: gscInspectionState.url,
            set: { lastInspectedAt: now, lastVerdict: verdict, lastCoverageState: coverage },
          });

        // Bing GetUrlInfo → bing_inspection_state (same upsert as runBingSweep;
        // ISO lastCrawled → Date|null for the timestamp column).
        const info = await getUrlInfo(env, fullUrl);
        const lastCrawled = info.lastCrawled ? new Date(info.lastCrawled) : null;
        await db
          .insert(bingInspectionState)
          .values({
            url: fullUrl,
            isIndexed: info.isIndexed,
            lastCrawled,
            crawlError: info.crawlError,
            lastCheckedAt: now,
          })
          .onConflictDoUpdate({
            target: bingInspectionState.url,
            set: {
              isIndexed: info.isIndexed,
              lastCrawled,
              crawlError: info.crawlError,
              lastCheckedAt: now,
            },
          });
      } catch {
        errors++;
      }
    }

    const nextCursor = cursor + chunk < total ? cursor + chunk : null;
    return NextResponse.json({
      ok: true,
      total,
      processed: posts.length,
      cursor,
      nextCursor,
      done: nextCursor === null,
      errors,
    });
  } catch (error) {
    // Never 500 — surface the failure as { ok:false } so the paginating client
    // can stop and show the message instead of choking on an HTML error body.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: "unknown", message });
  }
}

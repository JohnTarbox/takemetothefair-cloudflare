/**
 * Rolling Bing URL Inspection sweep — the Bing analogue of the GSC sweep in
 * `src/lib/gsc-sweep.ts`.
 *
 * Bing Webmaster Tools' GetUrlInfo returns per-URL indexation state (IsPage,
 * LastCrawledDate, CrawlError). Nothing persisted it before OPE-91, so the
 * /admin/blog "Bing" column had no data to show. This sweep pulls the least-
 * recently-checked published blog URLs (`${HOST}/blog/${slug}`), inspects each,
 * and upserts `bing_inspection_state`.
 *
 * Blog-first by design: the acceptance is the blog indexation column, and Bing's
 * GetUrlInfo is cached 15m and quota-limited, so we keep batches modest and
 * rotate least-recently-checked first. Extend to other page types (venues /
 * promoters / vendors) later if the column grows, mirroring the gsc sweep's
 * guaranteed per-type tiers.
 */

import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { blogPosts, bingInspectionState } from "@/lib/db/schema";
import { SITE_URL } from "@takemetothefair/constants";
import { getUrlInfo, type BingEnv } from "@/lib/bing-webmaster";

const DEFAULT_BATCH_SIZE = 10;
const HOST = SITE_URL;

export interface BingSweepResult {
  inspected: number;
  skipped: number;
  errors: string[];
}

/**
 * Pick the least-recently-checked published blog URLs to inspect this run. The
 * LEFT JOIN onto bing_inspection_state sorts never-checked posts first (SQLite
 * ASC puts NULL `last_checked_at` ahead), so coverage rotates across runs.
 */
export async function pickBingUrls(db: Database, batchSize: number): Promise<string[]> {
  const sample = await db
    .select({ slug: blogPosts.slug })
    .from(blogPosts)
    .leftJoin(
      bingInspectionState,
      eq(bingInspectionState.url, sql`${HOST} || '/blog/' || ${blogPosts.slug}`)
    )
    .where(eq(blogPosts.status, "PUBLISHED"))
    .orderBy(asc(bingInspectionState.lastCheckedAt))
    .limit(batchSize);
  return sample.map((r) => `${HOST}/blog/${r.slug}`);
}

/** Run a single Bing inspection sweep batch. */
export async function runBingSweep(
  db: Database,
  env: BingEnv,
  opts: { batchSize?: number } = {}
): Promise<BingSweepResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const result: BingSweepResult = { inspected: 0, skipped: 0, errors: [] };

  const urls = await pickBingUrls(db, batchSize);
  if (urls.length === 0) return result;

  const now = new Date();

  for (const url of urls) {
    // Defensive per-URL: one GetUrlInfo failure (transient 5xx, quota, parse)
    // must not abort the rest of the batch.
    try {
      const info = await getUrlInfo(env, url);
      const lastCrawled = info.lastCrawled ? new Date(info.lastCrawled) : null;
      await db
        .insert(bingInspectionState)
        .values({
          url,
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
      result.inspected++;
    } catch (error) {
      result.skipped++;
      result.errors.push(`${url}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  return result;
}

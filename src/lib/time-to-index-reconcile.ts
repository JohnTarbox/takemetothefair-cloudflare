/**
 * REL5 (2026-06-26) — time-to-index reconciler, sourced from BING crawl data.
 *
 * IndexNow pings **Bing**, so the "time to index" we care about is Bing's first
 * crawl after our submission. The prior reconciler joined `time_to_index_log`
 * against `gsc_inspection_state` where `lastVerdict='PASS'` — i.e. GOOGLE's
 * index state. Google rarely returns PASS for these (largely thin / recurring)
 * URLs, so the join almost never matched and `first_crawl_at` stayed NULL across
 * all 5,924 rows even though Bing had demonstrably crawled them
 * (`get_bing_url_info` → `isIndexed:true` with a real `lastCrawled`).
 *
 * This module takes an injected per-URL crawl lookup (the route wires it to
 * `getUrlInfo` from the Bing client) so the gating logic is unit-testable
 * without live API calls. There is no local Bing table to JOIN against, so the
 * lookup is a live, rate-limited API call — the caller caps `limit` per run and
 * the daily cron drains the backlog over successive runs (no instant backfill
 * under Bing's quota).
 */
import { asc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { timeToIndexLog } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export interface CrawlLookupResult {
  /** ISO 8601 of Bing's most-recent crawl, or null if never crawled. */
  lastCrawled: string | null;
}

/** Per-URL crawl lookup. Throws on API failure; a thrown error whose `.status`
 *  is 429 signals quota exhaustion and stops the run early. */
export type CrawlLookup = (url: string) => Promise<CrawlLookupResult>;

export interface ReconcileResult {
  /** Total unresolved (first_crawl_at IS NULL) rows before this run. */
  scanned: number;
  /** Rows we successfully looked up this run. */
  checked: number;
  /** Rows newly resolved (first_crawl_at written). */
  reconciled: number;
  /** True if a 429 from the lookup halted the run early. */
  quotaStopped: boolean;
  /** Per-URL lookup errors (non-429) that were skipped. */
  errors: number;
}

/**
 * Reconcile the oldest-submitted unresolved rows from a crawl lookup. Sets
 * `first_crawl_at`/`lag_seconds` only when the crawl happened STRICTLY AFTER the
 * IndexNow submission — that's the crawl our ping could have driven; an older
 * `lastCrawled` means Bing hasn't re-crawled since the ping, so the row stays
 * unresolved for a later run.
 */
export async function reconcileTimeToIndexFromCrawl(
  db: Db,
  lookup: CrawlLookup,
  opts: { limit: number; now?: Date }
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();

  const [{ scanned }] = await db
    .select({ scanned: sql<number>`COUNT(*)` })
    .from(timeToIndexLog)
    .where(isNull(timeToIndexLog.firstCrawlAt));

  // Oldest submissions first so each capped run chips away at the tail.
  const rows = await db
    .select({
      id: timeToIndexLog.id,
      url: timeToIndexLog.url,
      indexnowSubmittedAt: timeToIndexLog.indexnowSubmittedAt,
    })
    .from(timeToIndexLog)
    .where(isNull(timeToIndexLog.firstCrawlAt))
    .orderBy(asc(timeToIndexLog.indexnowSubmittedAt))
    .limit(opts.limit);

  let checked = 0;
  let reconciled = 0;
  let errors = 0;
  let quotaStopped = false;

  for (const r of rows) {
    let info: CrawlLookupResult;
    try {
      info = await lookup(r.url);
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 429) {
        quotaStopped = true;
        break;
      }
      errors++;
      continue;
    }
    checked++;

    const crawled = info.lastCrawled ? new Date(info.lastCrawled) : null;
    if (
      crawled &&
      !isNaN(crawled.getTime()) &&
      crawled.getTime() > r.indexnowSubmittedAt.getTime()
    ) {
      const lagSeconds = Math.floor((crawled.getTime() - r.indexnowSubmittedAt.getTime()) / 1000);
      await db
        .update(timeToIndexLog)
        .set({ firstCrawlAt: crawled, lagSeconds, computedAt: now })
        .where(eq(timeToIndexLog.id, r.id));
      reconciled++;
    }
  }

  return { scanned, checked, reconciled, quotaStopped, errors };
}

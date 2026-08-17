/**
 * OPE-424 — which published events have an authoritative source we cannot read?
 *
 * ---------------------------------------------------------------------------
 * Why this needed a new query rather than a `last_synced_at` filter
 * ---------------------------------------------------------------------------
 *
 * The obvious answer is "events where `last_synced_at IS NULL`". It is wrong.
 *
 * `lastSyncedAt` is stamped `new Date()` at CREATION — in the URL importer, the
 * bulk importer (four sites), the public submit route and the MCP vendor tool.
 * Every one of the 29 approved `http://`-sourced events therefore has a
 * non-null `last_synced_at`, and in every case it equals `created_at` to the
 * second. The column reads as "we synced this" and actually means "this row
 * exists". A non-null value is not evidence of a successful fetch.
 *
 * (Same defect family as `updated_at` before OPE-308, and the IndexNow pause
 * age in OPE-447: a field that looks like it measures one thing and measures
 * another. It is worth being suspicious of any timestamp whose writer is a
 * creation path.)
 *
 * So reachability has to come from the fetch OUTCOME, which is
 * `enrichment_log` — the rescrape sweep now writes `status='failure'` there on
 * an unreachable source (it previously recorded the error only in its HTTP
 * response body, which is why "unreachable" and "nothing changed" were
 * indistinguishable after the fact).
 */

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events, enrichmentLog } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export interface UnreachableSourceRow {
  eventId: string;
  name: string;
  slug: string;
  sourceDomain: string | null;
  sourceUrl: string | null;
  /** True when the source URL is plain HTTP — the class most likely to be a
   *  small organizer-run site, and least likely to have working TLS. */
  isPlainHttp: boolean;
  lastFailureAt: Date | null;
  lastFailureNote: string | null;
  /** Whether ANY scraper run has ever succeeded for this event. */
  everFetchedOk: boolean;
}

/**
 * Published events whose most recent scraper outcome was a failure, or which
 * have a recorded failure and no recorded success at all.
 *
 * Answers the acceptance question directly: an event listed here has an
 * authoritative source we could not read, and its displayed data is therefore
 * whatever we last derived from somewhere else — typically an aggregator.
 */
export async function getUnreachableSourceEvents(db: Db): Promise<UnreachableSourceRow[]> {
  const failures = await db
    .select({
      eventId: events.id,
      name: events.name,
      slug: events.slug,
      sourceDomain: events.sourceDomain,
      sourceUrl: events.sourceUrl,
      lastFailureAt: sql<
        number | null
      >`MAX(CASE WHEN ${enrichmentLog.status} = 'failure' THEN ${enrichmentLog.attemptedAt} END)`,
      lastSuccessAt: sql<
        number | null
      >`MAX(CASE WHEN ${enrichmentLog.status} = 'success' THEN ${enrichmentLog.attemptedAt} END)`,
      lastFailureNote: sql<
        string | null
      >`MAX(CASE WHEN ${enrichmentLog.status} = 'failure' THEN ${enrichmentLog.notes} END)`,
    })
    .from(events)
    .innerJoin(
      enrichmentLog,
      and(eq(enrichmentLog.targetId, events.id), eq(enrichmentLog.targetType, "event"))
    )
    .where(
      and(
        eq(events.status, "APPROVED"),
        isNotNull(events.sourceUrl),
        eq(enrichmentLog.source, "scraper")
      )
    )
    .groupBy(events.id)
    .having(sql`MAX(CASE WHEN ${enrichmentLog.status} = 'failure' THEN 1 ELSE 0 END) = 1`)
    .orderBy(
      desc(
        sql`MAX(CASE WHEN ${enrichmentLog.status} = 'failure' THEN ${enrichmentLog.attemptedAt} END)`
      )
    );

  return failures
    .filter((r) => {
      // A failure that has since been followed by a success is resolved.
      if (r.lastSuccessAt == null) return true;
      return Number(r.lastFailureAt ?? 0) > Number(r.lastSuccessAt);
    })
    .map((r) => ({
      eventId: r.eventId,
      name: r.name,
      slug: r.slug,
      sourceDomain: r.sourceDomain,
      sourceUrl: r.sourceUrl,
      isPlainHttp: !!r.sourceUrl && r.sourceUrl.toLowerCase().startsWith("http://"),
      lastFailureAt: r.lastFailureAt ? new Date(Number(r.lastFailureAt) * 1000) : null,
      lastFailureNote: r.lastFailureNote,
      everFetchedOk: r.lastSuccessAt != null,
    }));
}

/**
 * One-line digest summary. Returns null when there is nothing to report, so a
 * healthy week produces no block rather than a row of zeros nobody reads past.
 */
export function summarizeUnreachableSources(rows: UnreachableSourceRow[]): string | null {
  if (rows.length === 0) return null;
  const domains = new Set(rows.map((r) => r.sourceDomain ?? "unknown"));
  const neverOk = rows.filter((r) => !r.everFetchedOk).length;
  const plainHttp = rows.filter((r) => r.isPlainHttp).length;
  const parts = [`${rows.length} published events across ${domains.size} source hosts`];
  if (neverOk > 0) parts.push(`${neverOk} never fetched successfully`);
  if (plainHttp > 0) parts.push(`${plainHttp} on plain HTTP`);
  return `Unreachable authoritative sources — ${parts.join(", ")}`;
}

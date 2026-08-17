/**
 * OPE-433 item 6 — "how many live events assert confirmed dates with no
 * evidence, by ingestion method?"
 *
 * ---------------------------------------------------------------------------
 * The claim and the evidence are two unrelated columns
 * ---------------------------------------------------------------------------
 *
 * `event_data_citations` is real field-level provenance and is actively
 * written. `events.dates_confirmed` is an independent boolean declared
 * `DEFAULT true`. Nothing checks one against the other, so "confirmed" means
 * "nobody said otherwise" rather than "we have a source".
 *
 * Measured 2026-08-17: of 1,374 live events asserting `dates_confirmed`,
 * **1,244 have no active citation on `start_date` or `end_date`** — 90.5%.
 *
 * This module only MEASURES that. It changes no value and enforces nothing,
 * deliberately: the ticket separates labelling from remediation because
 * `dates_confirmed` has live customer-facing consumers, and flipping rows would
 * change what the public sees. Making the backlog visible is the prerequisite
 * for deciding what to do about it — not a substitute for that decision.
 *
 * ---------------------------------------------------------------------------
 * Consumers of `dates_confirmed` — audit before changing any value
 * ---------------------------------------------------------------------------
 *
 *   src/components/seo/EventSchema.tsx      Schema.org JSON-LD  ← structured data
 *   src/lib/newsletter/new-this-week.ts     outbound newsletter
 *   src/lib/events/relative-time-label.ts   on-page date copy
 *   (+ the vendor digest's "Dates TBC", per OPE-360)
 *
 * The JSON-LD consumer is worth singling out: a value change there alters what
 * search engines are told, not just what a page renders. The ticket flagged the
 * digest and said structured data "may" be affected — it is.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { events, eventDataCitations } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/** Date fields whose citation counts as backing a `dates_confirmed` claim. */
export const DATE_CITATION_FIELDS = ["start_date", "end_date"] as const;

export type DatesConfirmedBasis =
  /** Claims confirmed AND has an active citation on a date field. */
  | "cited"
  /** Claims confirmed with no active date citation — the 1,244. */
  | "uncited"
  /** Does not claim confirmation. Nothing to justify. */
  | "unclaimed";

export interface BasisByIngestionMethod {
  ingestionMethod: string;
  liveEvents: number;
  claimsConfirmed: number;
  confirmedUncited: number;
  /** Share of this lane's confirmations that have no evidence, 0–1. */
  uncitedShare: number;
}

export interface DatesConfirmedReport {
  liveEvents: number;
  claimsConfirmed: number;
  confirmedUncited: number;
  byIngestionMethod: BasisByIngestionMethod[];
}

/** SQL: does this event have an active citation on a date field? */
function hasActiveDateCitation() {
  return sql`EXISTS (
    SELECT 1 FROM ${eventDataCitations} c
    WHERE c.event_id = ${events.id}
      AND c.state = 'active'
      AND c.field_name IN ('start_date','end_date')
  )`;
}

/**
 * Per-lane breakdown of confirmed-without-evidence, so the backlog is visible
 * and shrinking rather than assumed.
 *
 * Ordered by `confirmedUncited` descending: the lanes with the most unbacked
 * claims are the ones worth fixing first, and it puts the worst offender at the
 * top without the caller having to sort.
 */
export async function getDatesConfirmedReport(db: Db): Promise<DatesConfirmedReport> {
  const live = and(sql`${events.status} IN ('APPROVED','TENTATIVE')`, isNull(events.mergedInto));

  const rows = await db
    .select({
      ingestionMethod: sql<string>`COALESCE(${events.ingestionMethod}, 'unknown')`,
      liveEvents: sql<number>`COUNT(*)`,
      claimsConfirmed: sql<number>`SUM(CASE WHEN ${events.datesConfirmed} = 1 THEN 1 ELSE 0 END)`,
      confirmedUncited: sql<number>`SUM(CASE WHEN ${events.datesConfirmed} = 1 AND NOT ${hasActiveDateCitation()} THEN 1 ELSE 0 END)`,
    })
    .from(events)
    .where(live)
    .groupBy(sql`COALESCE(${events.ingestionMethod}, 'unknown')`);

  const byIngestionMethod: BasisByIngestionMethod[] = rows
    .map((r) => {
      const claims = Number(r.claimsConfirmed ?? 0);
      const uncited = Number(r.confirmedUncited ?? 0);
      return {
        ingestionMethod: r.ingestionMethod,
        liveEvents: Number(r.liveEvents ?? 0),
        claimsConfirmed: claims,
        confirmedUncited: uncited,
        // Guard the divide: a lane can have live events and zero claims.
        uncitedShare: claims === 0 ? 0 : uncited / claims,
      };
    })
    .sort((a, b) => b.confirmedUncited - a.confirmedUncited);

  return {
    liveEvents: byIngestionMethod.reduce((n, r) => n + r.liveEvents, 0),
    claimsConfirmed: byIngestionMethod.reduce((n, r) => n + r.claimsConfirmed, 0),
    confirmedUncited: byIngestionMethod.reduce((n, r) => n + r.confirmedUncited, 0),
    byIngestionMethod,
  };
}

/**
 * The basis for ONE event — the read-only `cited | uncited | unclaimed` signal
 * the ticket asks for, computed rather than stored so it can never drift from
 * the citations it describes.
 */
export async function getDatesConfirmedBasis(
  db: Db,
  eventId: string
): Promise<DatesConfirmedBasis> {
  const [row] = await db
    .select({
      claims: events.datesConfirmed,
      cited: sql<number>`CASE WHEN ${hasActiveDateCitation()} THEN 1 ELSE 0 END`,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!row || row.claims !== true) return "unclaimed";
  return Number(row.cited) === 1 ? "cited" : "uncited";
}

/**
 * One-line digest summary. Returns null when every confirmation is backed, so a
 * healthy state produces no block rather than a row nobody reads past.
 */
export function summarizeDatesConfirmed(report: DatesConfirmedReport): string | null {
  if (report.confirmedUncited === 0) return null;
  const pct = Math.round((report.confirmedUncited / Math.max(1, report.claimsConfirmed)) * 100);
  const worst = report.byIngestionMethod[0];
  const worstNote = worst
    ? ` Worst lane: ${worst.ingestionMethod} (${worst.confirmedUncited} of ${worst.claimsConfirmed}).`
    : "";
  return (
    `${report.confirmedUncited} of ${report.claimsConfirmed} live events assert confirmed ` +
    `dates with no citation behind the claim (${pct}%).${worstNote}`
  );
}

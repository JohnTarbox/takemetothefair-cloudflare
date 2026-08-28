/**
 * OPE-617 — "has hours" must mean hours the public can attend.
 *
 * The daily sweep's `no_hours` gap asked only `COUNT(event_days) = 0` — whether
 * ANY schedule row exists. It did not ask whether the rows are open to the
 * public, or whether they fall inside the event's own span.
 *
 * Windsor Fair — Maine's second-largest agricultural fair, a 10-day run —
 * scored "has hours" on 2026-08-28, the day before it opened, on ONE row dated
 * 2026-08-27 with `vendor_only = 1` and the note "vendor setup and appreciation
 * event, not open to general public". Hopkinton State Fair scored the same on a
 * single row dated 2025.
 *
 * The public consequence is worse than "a thin schedule". `events/[slug]/
 * page.tsx:1158` filters `!d.vendorOnly` out of the schedule block, so the page
 * rendered NO SCHEDULE AT ALL while the metric reported the event had hours.
 * (The filing analyst flagged this as unverified and it is now confirmed by
 * reading the renderer — it was the empty-schedule case, not the wrong-schedule
 * one.) A metric confidently wrong in the direction of "nothing to do here" is
 * worse than a missing one.
 *
 * ── What is deliberately NOT counted ───────────────────────────────────────
 * `day_rows < span_days`. That framing is 20/23 false on live data — winter
 * farmers' markets (span 148–176 days, 20–26 weekly rows), the Connecticut
 * Renaissance Faire, King Richard's Faire and Strawbery Banke are legitimately
 * intermittent, and a weekends-only run is SUPPOSED to have fewer day rows than
 * calendar days. The analyst caught that by reading the 23 matches instead of
 * trusting the count, and the ticket asks explicitly that it not be built.
 *
 * Extracted from the data-health handler so a test can run THIS query rather
 * than a copy of it — a copied query drifts, and a drifted metric test is
 * exactly the thing that fails to notice a metric going wrong.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db.js";

export interface DayCoverage {
  /**
   * The corrected `no_hours`: the event HAS day rows, but none is both public
   * and in-span, so the schedule block renders empty.
   */
  no_public_days: number;
  /**
   * A row dated outside [start_date, end_date]. A distinct fault — the data is
   * PRESENT AND WRONG rather than absent, and it survives on events whose other
   * rows are fine.
   */
  out_of_span_days: number;
}

/**
 * Scoped to upcoming APPROVED events: a past fair's schedule cannot be acted
 * on, and this is a worklist rather than an audit.
 */
export async function readDayCoverage(db: Db): Promise<DayCoverage> {
  const [row] = await db.all<DayCoverage>(sql`
        SELECT
          (SELECT COUNT(*) FROM events e
             WHERE e.status = 'APPROVED' AND e.merged_into IS NULL
               AND e.end_date IS NOT NULL
               AND e.start_date >= strftime('%s','now')
               AND EXISTS (SELECT 1 FROM event_days d WHERE d.event_id = e.id)
               AND NOT EXISTS (
                 SELECT 1 FROM event_days d
                  WHERE d.event_id = e.id
                    AND d.vendor_only = 0
                    AND d.date BETWEEN date(e.start_date,'unixepoch')
                                   AND date(e.end_date,'unixepoch'))
          ) AS no_public_days,
          (SELECT COUNT(*) FROM events e
             WHERE e.status = 'APPROVED' AND e.merged_into IS NULL
               AND e.end_date IS NOT NULL
               AND e.start_date >= strftime('%s','now')
               AND EXISTS (
                 SELECT 1 FROM event_days d
                  WHERE d.event_id = e.id
                    AND (d.date < date(e.start_date,'unixepoch')
                      OR d.date > date(e.end_date,'unixepoch')))
          ) AS out_of_span_days
      `);
  return {
    no_public_days: Number(row?.no_public_days ?? 0),
    out_of_span_days: Number(row?.out_of_span_days ?? 0),
  };
}

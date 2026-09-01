/**
 * OPE-745 — make the provenance gap COUNTABLE instead of silent.
 *
 * OPE-744 ruled that most uncited values must NOT be given a synthesised
 * citation. `/api/suggest-event/submit` derives `ingestionMethod` from
 * `classifySource(sourceName, sourceUrl)` and cannot distinguish a value
 * EXTRACTED from that URL from one a human TYPED alongside it — so emitting a
 * citation there would assert "this source said this value" on rows where
 * nobody knows it. An absent citation is a known unknown; a fabricated one is a
 * false record that passes every audit written against it afterwards.
 *
 * What is left, then, is to stop the gap being invisible. That is this module:
 * a READ, no writes, surfaced in `get_data_health_report` where an operator
 * already looks.
 *
 * ── Two things this deliberately does NOT do ───────────────────────────────
 *
 * 1. It does not measure with `updated_at`. OPE-742 asked this question with an
 *    `updated_at` window and got 159 — a number dominated by legacy rows merely
 *    touched for unrelated reasons, which reads as "recent damage" and is not.
 *    Attribution belongs to `created_at`; `updated_at` answers a different
 *    question than the one it appears to.
 *
 * 2. It does not report one total. The same data split by ingestion path says
 *    something the total hides: the inbound-email pipeline (the only path that
 *    cites at all) is ~2% of the uncited population and has the BEST coverage,
 *    while `vendor_submission` carries the majority. A single number here
 *    misleads in both directions at once.
 *
 * Extracted into its own module for the same reason `day-coverage.ts` was: so a
 * test runs THIS query rather than a copy. A copied query drifts, and a drifted
 * metric test is exactly the thing that fails to notice a metric going wrong.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db.js";

/**
 * The tracked fields that are BOTH visitor-facing and on the citation
 * allow-list (`DENORM_FIELD_MAP` in admin-citations.ts).
 *
 * `column` is the denormalized `events` column; `field` is the citation
 * `field_name`. They differ (`ticket_price_min` ↔ `ticket_price_min_cents`),
 * and getting that pairing wrong yields a confident zero rather than an error —
 * so the pairs live here, once, next to the query that uses them.
 */
export const CITED_VALUE_FIELDS: ReadonlyArray<{ field: string; column: string }> = [
  { field: "ticket_price_min", column: "ticket_price_min_cents" },
  { field: "ticket_price_max", column: "ticket_price_max_cents" },
  { field: "vendor_fee_min", column: "vendor_fee_min_cents" },
  { field: "vendor_fee_max", column: "vendor_fee_max_cents" },
  { field: "estimated_attendance", column: "estimated_attendance" },
  { field: "application_deadline", column: "application_deadline" },
];

export interface FieldCoverage {
  field: string;
  /** Public events where the denormalized column holds a value. */
  populated: number;
  /** ...of those, how many carry an ACTIVE citation for that field. */
  cited: number;
  /** populated − cited. The gap this module exists to keep visible. */
  uncited: number;
}

export interface UncitedByMethod {
  ingestion_method: string;
  uncited: number;
}

export interface CitationCoverage {
  /** Per visitor-facing field. No target of zero — see `note`. */
  by_field: FieldCoverage[];
  /**
   * Where the ticket-price gap actually lives, by ingestion path. Price is used
   * as the representative field because it is the largest population and the
   * most consequential — somebody drives to a fair on it.
   */
  ticket_price_uncited_by_method: UncitedByMethod[];
  note: string;
}

/**
 * Scoped to APPROVED, non-tombstoned events — "visitor-facing" is the whole
 * premise, and a PENDING row's price is not on a public page. Tombstones are
 * excluded because their slug 301s away (OPE-432).
 */
const PUBLIC_SCOPE = sql`e.status = 'APPROVED' AND e.merged_into IS NULL`;

export async function readCitationCoverage(db: Db): Promise<CitationCoverage> {
  const by_field: FieldCoverage[] = [];

  // One statement per field rather than a UNION ALL of six. The UNION form is
  // tidier to read and hits D1's "compound SELECT ≤ 5 terms" ceiling at six
  // terms (FAM-D1-PARAMCAP, OPE-593) — a limit that does not exist in
  // better-sqlite3, so the tidier version would pass every test and fail in
  // production. Six cheap indexed counts is the boring correct shape.
  for (const { field, column } of CITED_VALUE_FIELDS) {
    const [row] = await db.all<{ populated: number; cited: number }>(sql`
      SELECT
        COUNT(*) AS populated,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM event_data_citations c
           WHERE c.event_id = e.id AND c.field_name = ${field} AND c.state = 'active'
        ) THEN 1 ELSE 0 END) AS cited
      FROM events e
      WHERE ${PUBLIC_SCOPE} AND ${sql.raw(`e."${column}"`)} IS NOT NULL
    `);
    const populated = Number(row?.populated ?? 0);
    const cited = Number(row?.cited ?? 0);
    by_field.push({ field, populated, cited, uncited: populated - cited });
  }

  const methods = await db.all<UncitedByMethod>(sql`
    SELECT COALESCE(e.ingestion_method, '(null)') AS ingestion_method,
           COUNT(*) AS uncited
      FROM events e
     WHERE ${PUBLIC_SCOPE}
       AND e.ticket_price_min_cents IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM event_data_citations c
          WHERE c.event_id = e.id AND c.field_name = 'ticket_price_min' AND c.state = 'active'
       )
     GROUP BY 1
     ORDER BY uncited DESC
  `);

  return {
    by_field,
    ticket_price_uncited_by_method: methods.map((m) => ({
      ingestion_method: m.ingestion_method,
      uncited: Number(m.uncited),
    })),
    note:
      "A POPULATION, not a fault: there is no target of zero and it must not be driven to zero by " +
      "backfilling. Most create paths cannot tell an EXTRACTED value from a TYPED one, so a " +
      "synthesised citation would assert a source nobody verified (OPE-744/OPE-745). Rising " +
      "`uncited` on a path that DOES cite (email_submission) is the real signal here.",
  };
}

/**
 * OPE-516 — which prior citations a new active citation retires. One rule, for
 * every writer.
 *
 * ── The rule, and why it is asymmetric ──────────────────────────────────
 *
 * A YEAR-STAMPED citation supersedes the same year AND year-null. A year-null
 * row is an unscoped claim about the field; a scoped one refines it.
 *
 * A YEAR-NULL citation supersedes year-null only. The inbound pipeline writes
 * year-null at scale, unattended; if a null citation retired every stamped row,
 * one re-ingest would wipe out every per-edition citation a human recorded.
 *
 * ── Why it lives in this package ────────────────────────────────────────
 *
 * PR #999 fixed this rule inside `create_event_citation` and its bulk twin.
 * `update_event`'s inline `citation` block carried its own copy of the OLD
 * exact-year bucket, and so did the goodwill flip in the main app. On
 * 2026-08-24, thirteen hours after #999 merged, an `update_event` correction on
 * Newport International Boat Show left a contradicting attendance citation
 * active and reported nothing — the fix had been wired into one of three
 * parallel paths. Two deploy artifacts both import this package, so it is the
 * one place none of them can miss; `citation-supersede-scope-ope516` asserts
 * every file that supersedes a citation calls it.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { eventDataCitations } from "./index";

export function citationSupersedeScope(
  eventId: string,
  fieldName: string,
  year: number | null | undefined
): SQL {
  const hasYear = year !== null && year !== undefined;
  return and(
    eq(eventDataCitations.eventId, eventId),
    eq(eventDataCitations.fieldName, fieldName),
    hasYear
      ? sql`(${eventDataCitations.year} IS NULL OR ${eventDataCitations.year} = ${year})`
      : sql`${eventDataCitations.year} IS NULL`
  ) as SQL;
}

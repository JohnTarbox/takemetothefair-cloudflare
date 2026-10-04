/**
 * OPE-408 rework (2026-10-04) — let the nightly geocode sweep converge.
 *
 * The confidence gate is deterministic for an unchanged record: 10-02 → 10-04
 * the sweep asked the same ~45 venues the same question three nights running,
 * got the same refusals (38 low-confidence, 4 duplicate-with, 3 not-a-point),
 * wrote nothing, and paid for every lookup.
 *
 * So the sweep counts refusals per venue and PARKS a venue after
 * GEOCODE_PARK_AFTER of them, until its record is edited
 * (updated_at > geocode_last_refused_at) — fixing the address is the only thing
 * that can change the gate's answer, and it un-parks the venue by itself.
 *
 * Two, not one, so a single odd Places answer cannot park a venue that would
 * resolve on the next try. `error` (a transient failure) never counts.
 */
import { sql, type SQL } from "drizzle-orm";
import { venues } from "@/lib/db/schema";

export const GEOCODE_PARK_AFTER = 2;

const REFUSAL_STATUSES: ReadonlySet<string> = new Set([
  "low-confidence",
  "no-match",
  "duplicate-with",
  "not-a-point",
  "insufficient-address",
]);

/** A deterministic, non-writing gate answer — the only kind that counts toward parking. */
export function isSweepRefusal(status: string): boolean {
  return REFUSAL_STATUSES.has(status);
}

/**
 * Parked = refused at least GEOCODE_PARK_AFTER times, and not edited since.
 * One fragment shared by the sweep's selection (to skip) and its count (to
 * report), so the two can never disagree about what "parked" means.
 */
export const PARKED: SQL = sql`(${venues.geocodeRefusals} >= ${GEOCODE_PARK_AFTER} AND ${venues.geocodeLastRefusedAt} IS NOT NULL AND (${venues.updatedAt} IS NULL OR ${venues.updatedAt} <= ${venues.geocodeLastRefusedAt}))`;

/** Anything with drizzle's `run(sql)` — D1 in production, better-sqlite3 in tests. */
interface RunsSql {
  run(query: SQL): unknown;
}

/**
 * Count one refusal against a venue. RAW SQL DELIBERATELY: `venues.updatedAt`
 * carries `$onUpdateFn`, so a Drizzle `.update(venues)` would stamp it —
 * moving the venue's ETag and sitemap lastmod every night (the #819 class),
 * and un-parking it the instant it was parked.
 */
export async function recordSweepRefusal(db: RunsSql, venueId: string): Promise<void> {
  // AUDIT-EXEMPT: a bookkeeping counter, not public content — no rendered
  // field changes. Every sweep run that increments it is already recorded by
  // its own `venue.geocode.sweep` admin_actions row (with the parked count).
  await db.run(
    sql`UPDATE venues SET geocode_refusals = geocode_refusals + 1, geocode_last_refused_at = unixepoch('now') WHERE id = ${venueId}`
  );
}

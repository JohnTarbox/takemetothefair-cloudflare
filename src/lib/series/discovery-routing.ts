/**
 * EH3 P3.3 — discovery match-to-series routing (pure).
 *
 * When an incoming (discovered/suggested) event matches an existing one via
 * findDuplicate, decide what to do with it — per John's locked Q4 policy:
 *
 *   - same-year match            → `duplicate` (a true duplicate; today's path)
 *   - existing has a series + a
 *     DIFFERENT year + not vendor-bearing → `occurrence` (create under the
 *     series via create_occurrence, but still review-gated by the caller)
 *   - vendor-bearing / no series / unknown year → `stage` (standalone candidate
 *     for operator triage — never auto-link on a weak/risky signal)
 *   - no match                   → `create_new` (normal create)
 *
 * Pure + unit-tested; the suggest_event / submit path acts on the result. Until
 * the P1 backfill sets series_id, existingSeriesId is always null, so this never
 * returns `occurrence` and ingestion behaves exactly as today.
 */
export interface DiscoveryMatch {
  /** Did findDuplicate return a hit? */
  matched: boolean;
  /** The matched event's series_id (null = standalone). */
  existingSeriesId: string | null;
  /** The matched event's start-year (null = undated). */
  existingYear: number | null;
  /** The matched event carries a vendor roster → too risky to auto-link. */
  existingVendorBearing: boolean;
  /** The matched event is itself a rolled skeleton (rolled_from set) — surfaced. */
  existingRolledEdition: boolean;
  /** The incoming event's start-year (null = undated). */
  incomingYear: number | null;
}

export type DiscoveryRouting =
  | { action: "create_new" }
  | { action: "duplicate" }
  | { action: "occurrence"; seriesId: string; year: number; warning?: string }
  | {
      action: "stage";
      reason: "vendor-bearing" | "no-series" | "year-unknown";
      warning?: string;
    };

export function decideDiscoveryRouting(m: DiscoveryMatch): DiscoveryRouting {
  if (!m.matched) return { action: "create_new" };

  const rolledWarn = m.existingRolledEdition
    ? "matched event is a rolled skeleton — verify the series root before linking"
    : undefined;

  // Same concrete year → a genuine duplicate, not a new edition.
  if (m.existingYear !== null && m.incomingYear !== null && m.existingYear === m.incomingYear) {
    return { action: "duplicate" };
  }

  // Vendor roster on the match → human triage, never auto-create an occurrence.
  if (m.existingVendorBearing) {
    return { action: "stage", reason: "vendor-bearing", warning: rolledWarn };
  }

  // Series + different known years → create the edition under the series.
  if (m.existingSeriesId && m.existingYear !== null && m.incomingYear !== null) {
    return {
      action: "occurrence",
      seriesId: m.existingSeriesId,
      year: m.incomingYear,
      warning: rolledWarn,
    };
  }

  // Series exists but a year is unknown → can't bucket the edition safely.
  if (m.existingSeriesId) {
    return { action: "stage", reason: "year-unknown", warning: rolledWarn };
  }

  // No series on the match → today's standalone-candidate behavior.
  return { action: "stage", reason: "no-series", warning: rolledWarn };
}

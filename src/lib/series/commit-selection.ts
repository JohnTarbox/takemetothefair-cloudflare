/**
 * EH3 P1 — commit-policy selection (pure).
 *
 * Given the grouping proposal, decide which groups are SAFE to write as series
 * in the backfill and which must be held back, per John's locked decisions
 * (docs/eh3-p1-backfill-scoping.md):
 *
 *   - `already-exists`  — a series with this canonical_slug is already present
 *     (idempotent re-run; never double-create).
 *   - `same-year-conflict` — two members share a start-year → likely a true
 *     duplicate; route to merge_events FIRST, do not co-link as occurrences.
 *   - `needs-manual-confirm` — multi-occurrence AND vendor-bearing (the roster-
 *     fuse risk); commit only when its canonical_slug is in `confirmedSlugs`.
 *
 * Everything else commits. Pure + deterministic — the route executes the result.
 */
import type { SeriesGroup } from "./group-events";

export type SkipReason = "already-exists" | "same-year-conflict" | "needs-manual-confirm";

export interface SkippedGroup {
  canonicalSlug: string;
  reason: SkipReason;
}

export interface CommitSelection {
  commit: SeriesGroup[];
  skipped: SkippedGroup[];
}

export function selectCommittableGroups(
  groups: SeriesGroup[],
  opts: { confirmedSlugs?: readonly string[]; existingSeriesSlugs?: readonly string[] } = {}
): CommitSelection {
  const confirmed = new Set(opts.confirmedSlugs ?? []);
  const existing = new Set(opts.existingSeriesSlugs ?? []);

  const commit: SeriesGroup[] = [];
  const skipped: SkippedGroup[] = [];

  for (const g of groups) {
    // Order matters: idempotency first, then the two safety holds.
    if (existing.has(g.canonicalSlug)) {
      skipped.push({ canonicalSlug: g.canonicalSlug, reason: "already-exists" });
    } else if (g.sameYearConflict) {
      skipped.push({ canonicalSlug: g.canonicalSlug, reason: "same-year-conflict" });
    } else if (g.needsManualConfirm && !confirmed.has(g.canonicalSlug)) {
      skipped.push({ canonicalSlug: g.canonicalSlug, reason: "needs-manual-confirm" });
    } else {
      commit.push(g);
    }
  }

  return { commit, skipped };
}

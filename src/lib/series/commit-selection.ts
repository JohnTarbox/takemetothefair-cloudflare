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

export type SkipReason =
  | "already-exists"
  | "same-year-conflict"
  | "needs-manual-confirm"
  | "canonical-collision";

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

  // Hold canonical-slug collisions among the would-be-committed groups.
  // `groupEvents` assigns each group's canonicalSlug independently, so two
  // groups can resolve to the same slug (same stem at different venues, neither
  // with a clean member). event_series.canonical_slug is UNIQUE, so committing
  // both would violate the constraint and roll back the whole batch. A collision
  // is also a data signal — sometimes a duplicate venue to merge, sometimes two
  // genuinely-distinct same-named events needing distinct slugs — so we never
  // auto-resolve it: hold ALL members of a colliding slug for operator triage,
  // mirroring the same-year-conflict hold.
  const slugCounts = new Map<string, number>();
  for (const g of commit)
    slugCounts.set(g.canonicalSlug, (slugCounts.get(g.canonicalSlug) ?? 0) + 1);

  const finalCommit: SeriesGroup[] = [];
  for (const g of commit) {
    if ((slugCounts.get(g.canonicalSlug) ?? 0) > 1) {
      skipped.push({ canonicalSlug: g.canonicalSlug, reason: "canonical-collision" });
    } else {
      finalCommit.push(g);
    }
  }

  return { commit: finalCommit, skipped };
}

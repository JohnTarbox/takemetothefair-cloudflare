/**
 * OPE-391 — the discrepancy-resolution bucketing rule, in ONE place.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The rule "which `resolution_status` values count as resolved" was written
 * twice, in the same artifact, and a third copy was about to be written in the
 * Next.js app for the Site Health tab:
 *
 *   mcp-server/src/tools/admin-data-health.ts   the on-demand report
 *   mcp-server/src/goodwill/health-canary.ts    the nightly snapshot WRITER
 *
 * They agreed by luck. The second one persists its answer into
 * `goodwill_health_snapshots.resolved_last_28d`, so a divergence would not
 * merely disagree on a screen — it would write a permanent, wrong history.
 *
 * ── The rule is not obvious, and the obvious reading is misleading ────────
 *
 * Both copies said: `dismissed` → dismissed, anything not `open` → RESOLVED.
 * That sweeps three bookkeeping statuses into "resolved". Measured on prod
 * 2026-08-30, resolved within 28 days:
 *
 *     superseded_duplicate           6,574   <- the 2026-08-04 bulk dedup
 *     superseded_by_normalization      226   <- the normalizer already fixed it
 *     superseded_by_lifecycle          194   <- the event simply ended
 *     resolved_authoritative            33   <- an authority actually said so
 *     self_resolved                      7
 *     resolved_divergent                 5
 *     dismissed                          7
 *
 * Under the legacy rule "ground truth coverage" is 7,039 / 7,046 = **0.999**,
 * which reads as a near-perfect quality signal and is nothing of the sort: a
 * one-off duplicate cleanup is 93% of the numerator. The rows where somebody
 * or something actually adjudicated the truth are 45 against 7 dismissed —
 * **0.865**. That is the number worth putting on a health page.
 *
 * Note the shape of how this happened. The G1/G2/G3 cleanup deliberately
 * avoided marking those rows `dismissed` *because dismissed feeds a live
 * metric* — and by landing them in the resolved bucket it fed the very same
 * metric from the other side, inflating it instead of depressing it.
 *
 * ── What this file does NOT change ────────────────────────────────────────
 *
 * `resolvedLegacy` reproduces the old total exactly, and `health-canary` still
 * persists that into `resolved_last_28d`. 87 days of snapshot history were
 * written under the old definition; redefining the column would make new rows
 * silently incomparable with old ones — a broken trend line that still draws.
 * The honest split is ADDITIVE, and the new UI leads with it.
 */

/** Statuses where a human or an authority actually adjudicated the value. */
export const ADJUDICATED_STATUSES = [
  "resolved_authoritative",
  "resolved_divergent",
  "self_resolved",
] as const;

/**
 * Statuses that closed the row without anyone judging the data — a duplicate
 * swept up, a normalizer that had already fixed it, an event that simply
 * ended. Real closures, but bookkeeping: they say nothing about whether our
 * data matched the truth.
 */
export const SUPERSEDED_STATUSES = [
  "superseded_duplicate",
  "superseded_by_lifecycle",
  "superseded_by_normalization",
] as const;

/** The window every "…_last_28d" figure on this surface uses. */
export const DATA_HEALTH_WINDOW_DAYS = 28;

export interface ResolutionStatusCount {
  status: string | null;
  count: number | string;
}

export interface ResolutionSummary {
  /** An authority or operator judged the value. */
  adjudicated: number;
  /** Closed as bookkeeping — see SUPERSEDED_STATUSES. */
  superseded: number;
  dismissed: number;
  resolvedAuthoritative: number;
  resolvedDivergent: number;
  selfResolved: number;
  /**
   * `adjudicated + superseded` — byte-identical to the pre-OPE-391 "resolved"
   * total. Persisted into `goodwill_health_snapshots.resolved_last_28d` so the
   * 87-day trend stays comparable. Do NOT use it for a quality signal.
   */
  resolvedLegacy: number;
  /**
   * Of the rows somebody actually judged, the share we got right.
   * `adjudicated / (adjudicated + dismissed)`.
   *
   * NULL, never 0, when the denominator is empty — a window with no
   * adjudications has no coverage to report, and 0 would read as "we were
   * wrong about everything" (B8: never silently zero).
   */
  adjudicatedCoverage: number | null;
  /**
   * The pre-OPE-391 coverage: `resolvedLegacy / (resolvedLegacy + dismissed)`.
   * Retained so the existing MCP field keeps its published meaning. It is
   * dominated by bulk cleanups; prefer `adjudicatedCoverage`.
   */
  legacyCoverage: number | null;
}

/**
 * Bucket grouped `(resolution_status, count)` rows.
 *
 * Takes the grouped rows rather than a db handle on purpose: the query is two
 * self-evident lines that each artifact writes in its own Drizzle flavour, and
 * the part that must never diverge is this classification. A shared db
 * abstraction would be more code and less safety.
 *
 * `open` rows are ignored — they are not resolutions. An unrecognised status
 * is counted in neither bucket but IS counted in nothing silently: it simply
 * does not inflate a coverage figure, which is the safe direction for a value
 * this function has never seen.
 */
export function summarizeResolutions(rows: readonly ResolutionStatusCount[]): ResolutionSummary {
  let adjudicated = 0;
  let superseded = 0;
  let dismissed = 0;
  let resolvedAuthoritative = 0;
  let resolvedDivergent = 0;
  let selfResolved = 0;

  for (const row of rows) {
    const n = Number(row.count) || 0;
    const status = row.status;
    if (status === "open" || status == null) continue;
    if (status === "dismissed") {
      dismissed += n;
      continue;
    }
    if ((ADJUDICATED_STATUSES as readonly string[]).includes(status)) {
      adjudicated += n;
      if (status === "resolved_authoritative") resolvedAuthoritative += n;
      if (status === "resolved_divergent") resolvedDivergent += n;
      if (status === "self_resolved") selfResolved += n;
      continue;
    }
    if ((SUPERSEDED_STATUSES as readonly string[]).includes(status)) {
      superseded += n;
    }
  }

  const resolvedLegacy = adjudicated + superseded;
  const ratio = (num: number, den: number) => (den === 0 ? null : num / den);

  return {
    adjudicated,
    superseded,
    dismissed,
    resolvedAuthoritative,
    resolvedDivergent,
    selfResolved,
    resolvedLegacy,
    adjudicatedCoverage: ratio(adjudicated, adjudicated + dismissed),
    legacyCoverage: ratio(resolvedLegacy, resolvedLegacy + dismissed),
  };
}

/**
 * How many whole days old the newest health snapshot is, or null if there is
 * none.
 *
 * `snapshotDate` is a `YYYY-MM-DD` UTC string, not a timestamp — comparing it
 * as a Date would drag local-timezone rules into a value that has none, so
 * both sides are reduced to a UTC day number first.
 */
export function snapshotAgeDays(snapshotDate: string | null | undefined, now: Date): number | null {
  if (!snapshotDate) return null;
  const parsed = Date.parse(`${snapshotDate}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
  return Math.max(0, dayOf(now.getTime()) - dayOf(parsed));
}

/**
 * True when the nightly snapshot has not run recently enough to trust the
 * trend line.
 *
 * The threshold is 2 days, not 1: the canary writes at a fixed UTC hour, so a
 * page loaded before it runs is legitimately looking at yesterday's row. Two
 * days means it actually missed a night.
 *
 * A MISSING snapshot is stale, not fresh. That is the whole point — the defect
 * this guards is "the writer stopped and every number froze at its last good
 * value", which is indistinguishable from health unless something checks.
 */
export function isSnapshotStale(
  snapshotDate: string | null | undefined,
  now: Date,
  maxAgeDays = 2
): boolean {
  const age = snapshotAgeDays(snapshotDate, now);
  if (age === null) return true;
  return age > maxAgeDays;
}

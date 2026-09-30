/**
 * OPE-815 — what one drift-sweep fetch concluded.
 *
 * Extracted from `sweep/route.ts` so the decision can be exercised. The branch
 * this replaces was a bare `if (drift > THRESHOLD)` with **no else**, inside a
 * Next route handler that no test reaches — so the missing case was invisible
 * in exactly the way OPE-6 v3.8 is about: a control indistinguishable from a
 * control that is not there.
 *
 * ## The three outcomes are genuinely different, and were two
 *
 *   `drift-recorded`  fetched, and the source disagrees. File/refresh.
 *   `drift-cleared`   fetched, and the source now AGREES. Close the finding.
 *   `fetch-failed`    could not read the page. Change nothing.
 *
 * `drift-cleared` did not exist. When an organizer fixed their page the sweep
 * took no branch at all, the old finding stayed `resolved_at IS NULL`, the
 * radar lifted it again next run, and `captureDiscrepancy` refreshed
 * `last_seen_at` on the open discrepancy — producing a corrected page whose row
 * read "verified this morning".
 *
 * ⚠️ Note this is NOT the "re-stamped without re-reading" the ticket describes.
 * The page WAS re-read; the agreement was discarded. The distinction decides
 * the fix: gating the timestamp on a real fetch would not have closed the
 * `jenksproductions.com` specimen, because its fetch succeeded.
 *
 * `fetch-failed` must stay distinct from both. A site that starts 403ing us
 * would otherwise become indistinguishable from a site that is still wrong —
 * the same shape as OPE-373 ("was true once", never "is true now") and OPE-567
 * (a stale verdict read as current).
 */

export type SweepOutcome = "drift-recorded" | "drift-cleared" | "fetch-failed";

export function classifySweepOutcome(
  canonicalStartDate: Date | null,
  driftDays: number,
  thresholdDays: number
): SweepOutcome {
  // No readable date on the page — we learned nothing, so we assert nothing.
  if (!canonicalStartDate) return "fetch-failed";
  if (!Number.isFinite(driftDays)) return "fetch-failed";
  return Math.abs(driftDays) > thresholdDays ? "drift-recorded" : "drift-cleared";
}

/** Only a completed, disagreeing read may refresh a finding's recency. */
export function mayRefreshRecency(outcome: SweepOutcome): boolean {
  return outcome === "drift-recorded";
}

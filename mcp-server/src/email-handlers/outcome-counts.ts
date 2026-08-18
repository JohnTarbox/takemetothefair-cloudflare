/**
 * OPE-460 — "Thanks for submitting 6 events" when one event was created.
 *
 * The `ok-multi` reply renders `eventCount`, and all three call sites passed
 * `outcomes.length`. But `SourceOutcome` mixes results with failures:
 *
 *     kind: "created" | "already-exists"
 *         | "submit-failed" | "extract-failed" | "fetch-failed"
 *
 * So the headline counted **attempts**, and every failed fetch inflated it. The
 * body of the same email then listed those failures with ❌ — which is why the
 * reply could say "6 events" directly above five lines explaining that five of
 * them did not work.
 *
 * The number the sender cares about is how many events are now in the
 * directory: `created` plus `already-exists`. An already-listed event is a real
 * outcome — their event IS there — so it counts; a failure is not, so it does
 * not.
 *
 * This is a correctness fix to a number, not a rewrite of the sentence: the
 * template around it is untouched.
 */

export type OutcomeKind =
  | "created"
  | "already-exists"
  | "submit-failed"
  | "extract-failed"
  | "fetch-failed";

export interface OutcomeCounts {
  /** Newly created, PENDING review. */
  created: number;
  /** Matched an event already in the directory. */
  alreadyExists: number;
  /** Attempts that produced nothing. */
  failed: number;
  /** What the headline should say: created + alreadyExists. */
  landed: number;
  /** Every outcome, i.e. the old (wrong) headline value. */
  attempted: number;
}

export function countOutcomes(outcomes: ReadonlyArray<{ kind: OutcomeKind }>): OutcomeCounts {
  let created = 0;
  let alreadyExists = 0;
  let failed = 0;
  for (const o of outcomes) {
    if (o.kind === "created") created++;
    else if (o.kind === "already-exists") alreadyExists++;
    else failed++;
  }
  return {
    created,
    alreadyExists,
    failed,
    landed: created + alreadyExists,
    attempted: outcomes.length,
  };
}

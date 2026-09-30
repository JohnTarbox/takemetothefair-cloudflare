/**
 * OPE-964 + OPE-249 — a value a human turned down is never auto-applied again.
 *
 * Both enrichment lanes restage every run and auto-merge unflagged fills into
 * EMPTY columns. A human rejection therefore lasted exactly one cycle: the
 * field stays empty, the next render proposes the identical value, and it
 * auto-merges. Measured in prod: promoter #1955 (maine-grain-alliance, a
 * twitter search URL) rejected 08-26 → the identical value auto-merged as
 * #2875 on 09-15; #1901 → #2843 (The Weston Craft Show, Squarespace's own
 * accounts) the same way.
 *
 * OPE-964 closed this for REVERTS in the promoter lane only. A rejection is the
 * stronger verdict and the vendor lane shares the defect, so the rule lives
 * here once and both lanes call it — two copies of a guard is how one lane
 * gets forgotten, which is how this one was.
 *
 * The value still STAGES (a human may change their mind, and the queue shows
 * why); the flag is what keeps it out of both lanes' applyFills, which skip any
 * flagged candidate.
 */

export type HumanVerdict = "reverted" | "rejected";

export const HUMAN_VETO_DECISIONS: readonly HumanVerdict[] = ["reverted", "rejected"];

const FLAG: Record<HumanVerdict, string> = {
  // Name kept from OPE-964 so existing readers of it are unaffected.
  reverted: "previously_reverted",
  rejected: "previously_rejected",
};

const keyOf = (field: string, value: string) => `${field}\n${value.trim()}`;

/** Adds the veto flag, in place, to every proposal a human already turned down. */
export function applyHumanVeto(
  proposals: { field: string; proposedValue: string; flags: string[] }[],
  priorVerdicts: { field: string; value: string; decision: string }[]
): void {
  const flagFor = new Map<string, string>();
  for (const v of priorVerdicts) {
    if (v.decision !== "reverted" && v.decision !== "rejected") continue;
    const k = keyOf(v.field, v.value);
    // A rejection outranks a revert for the same value.
    if (!flagFor.has(k) || v.decision === "rejected") flagFor.set(k, FLAG[v.decision]);
  }
  for (const p of proposals) {
    const flag = flagFor.get(keyOf(p.field, p.proposedValue));
    if (flag && !p.flags.includes(flag)) p.flags.push(flag);
  }
}

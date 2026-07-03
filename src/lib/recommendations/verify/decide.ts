/**
 * OPE-77 (CPI Move 3) — pure disposition core for the recommendations verify
 * loop. Given the snapshot metric captured at act time (`before`) and the metric
 * re-read after the rule's lag (`after`), decide whether the acted item improved
 * or showed no movement, with a short human-readable reason.
 *
 * Pure, no I/O, never throws. The rule→logic mapping is a small switch so more
 * rules can be added alongside their registry entry (registry.ts).
 */

export type VerifyOutcome = "improved" | "no_movement";

export interface VerifyDecision {
  outcome: VerifyOutcome;
  reason: string;
}

/** Safe numeric read from a loosely-typed metric object (defaults to 0). */
function num(m: Record<string, number>, key: string): number {
  const v = m[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function decideVerifyOutcome(
  ruleKey: string,
  before: Record<string, number>,
  after: Record<string, number>
): VerifyDecision {
  switch (ruleKey) {
    case "page_1_zero_click_queries": {
      // The rule matched because clicks === 0 on a page-1 query. It "improved"
      // the moment the query starts earning clicks; otherwise it hasn't moved.
      const afterClicks = num(after, "clicks");
      if (afterClicks > 0) {
        return { outcome: "improved", reason: `clicks 0 → ${afterClicks}` };
      }
      const pos = num(after, "position");
      return {
        outcome: "no_movement",
        reason: `still 0 clicks (position ${pos.toFixed(1)})`,
      };
    }
    default:
      // Unknown rule — should never happen (only registry rules reach here).
      // Treat as no_movement so the item re-opens rather than silently clearing.
      return { outcome: "no_movement", reason: "no verifier logic for rule" };
  }
}

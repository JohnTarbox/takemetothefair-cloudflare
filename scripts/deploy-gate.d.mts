export interface GateDecision {
  decision: "deploy" | "skip";
  sha: string | null;
  reason: string;
  /** OPE-1655 — a skip that must FAIL the deploy run (main's HEAD did not deploy). */
  loud: boolean;
}
export function decide(input: {
  eventName: string;
  event: unknown;
  repository: string;
  ref: string;
  mainHeadSha: string | null;
  mainHeadCiConclusion?: string | null;
}): GateDecision;

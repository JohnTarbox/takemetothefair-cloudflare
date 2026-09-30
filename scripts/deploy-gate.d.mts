export interface GateDecision {
  decision: "deploy" | "skip";
  sha: string | null;
  reason: string;
}
export function decide(input: {
  eventName: string;
  event: unknown;
  repository: string;
  ref: string;
  mainHeadSha: string | null;
  mainHeadCiConclusion?: string | null;
}): GateDecision;

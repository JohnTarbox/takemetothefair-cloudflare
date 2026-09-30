/**
 * OPE-1134 — which acknowledgement a sender gets, from what they ASKED.
 *
 * `toWorkflowIntent` collapses the classifier's intents onto the legacy
 * dispatch surface: `vendor_inquiry` → `support`, `claim_request` →
 * `correction`. The handlers then picked their template from the COLLAPSED
 * intent, so a vendor asking how to take part got the bug-report `support-ack`
 * (3 of the 5 vendor inquiries on record — Carol Pace at David Lerner
 * Associates then heard nothing for 8 weeks), and a performer asking to claim
 * his listing got `correction-ack` ("we've recorded your correction request").
 *
 * The classifier's own intent survives on the row as `classified_intent`; this
 * reads it. One pure function, used by every handler that acks, so the mapping
 * is pinned in one place and tested pair by pair.
 */
import type { ReplyKind } from "./types.js";

export type AckKind = Extract<
  ReplyKind,
  "support-ack" | "vendor-inquiry-ack" | "claim-request-ack" | "correction-ack" | "press-ack"
>;

export function ackKindForIntent(classifiedIntent: string | null | undefined): AckKind {
  switch (classifiedIntent) {
    case "vendor_inquiry":
      return "vendor-inquiry-ack";
    case "claim_request":
      return "claim-request-ack";
    case "correction":
    case "source_suggestion":
      return "correction-ack";
    case "press":
      return "press-ack";
    default:
      // support, unclear, null (address-routed mail) — the general ack.
      return "support-ack";
  }
}

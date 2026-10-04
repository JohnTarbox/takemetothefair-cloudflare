/**
 * OPE-278 — attendee-list brokers, and senders the operator has BLOCKED, are
 * held on receipt: no classifier, no workflow, no ack of any kind.
 *
 * Two holes this closes, both measured on prod 2026-10-04:
 *
 * 1. `trust_status='blocked'` decided nothing on receipt. The handler only read
 *    the tier for the `trusted` fast-path; the one reader of `blocked` was the
 *    UNROUTED hold step, which suppresses a follow-up QUESTION and nothing else.
 *    A blocked sender was still classified and could still be acknowledged.
 * 2. The brokers rotate addresses. Two of the four known ones share the
 *    `leadstream` token, and the 09-18 one (`charles.anderson.leadstream@…`) got
 *    a support-ack through a classifier timeout. An address-keyed block cannot
 *    catch the next fresh address; the subject shape can.
 *
 * The subject rule was measured against every inbound subject on 2026-10-04:
 * it matches all 5 broker emails ever received, and 0 of the 21 subjects that
 * contain "Visitor's Guide" (our own blog-mention notices). Those are the
 * near-miss it must keep missing, so they are pinned in the test.
 */

export type SolicitationHoldKind = "blocked-sender" | "list-broker";

export interface SolicitationHold {
  kind: SolicitationHoldKind;
  /** Short, stable, greppable — stored as the held row's reason. */
  reason: string;
}

/** Local-part tokens list brokers have signed with. Split on . - _ + */
export const LIST_BROKER_LOCAL_TOKENS: readonly string[] = ["leadstream"];

/**
 * "Attendee List", "Complete Visitor List", "Complete Attendee Information",
 * "Registrant Data"… — the audience noun FOLLOWED BY a data noun. Requiring
 * the second word is what keeps "Visitor's Guide" out.
 */
const AUDIENCE_DATA_RE =
  /\b(?:attendee|visitor|registrant)s?(?:'s)?\s+(?:list|lists|information|info|data|database|contacts?|emails?|mailing)\b/i;

/** "Full List of Registered Visitors", "List of Attendees". */
const LIST_OF_AUDIENCE_RE =
  /\blist\s+of\s+(?:all\s+)?(?:registered\s+)?(?:attendees|visitors|registrants)\b/i;

export function detectListBrokerSolicitation(input: {
  subject: string | null | undefined;
  fromAddr: string;
}): SolicitationHold | null {
  const local = input.fromAddr.trim().toLowerCase().split("@")[0] ?? "";
  const token = local.split(/[.\-_+]/).find((t) => LIST_BROKER_LOCAL_TOKENS.includes(t));
  if (token) return { kind: "list-broker", reason: `list-broker:sender-token:${token}` };

  const subject = input.subject ?? "";
  if (AUDIENCE_DATA_RE.test(subject) || LIST_OF_AUDIENCE_RE.test(subject)) {
    return { kind: "list-broker", reason: "list-broker:subject" };
  }
  return null;
}

/**
 * The receipt-time decision. An explicit operator block wins over the
 * pattern, so the stored reason names the operator's decision when there is one.
 */
export function decideSolicitationHold(input: {
  senderTrust: string;
  subject: string | null | undefined;
  fromAddr: string;
}): SolicitationHold | null {
  if (input.senderTrust === "blocked") {
    return { kind: "blocked-sender", reason: "blocked-sender:trust_status" };
  }
  return detectListBrokerSolicitation(input);
}

/**
 * OPE-365 (R1) — who gets a support obligation, and who does not.
 *
 * Extracted and pure because the ticket's acceptance turns on replaying two
 * real production messages through this decision:
 *
 *   Katie   ktkellycrafts@gmail.com   support 0.90  flagged_for_review=0  MISSED
 *   outreach wayne@plushcargo.com     support 0.82  flagged_for_review=1  flagged
 *
 * A decision buried inside a Workflow handler cannot be replayed against those
 * rows without running the Workflow. This one can.
 */

/** The intents whose handler terminates in an acknowledgement rather than an action. */
export const ACK_TERMINATING_INTENTS = ["support", "vendor_inquiry", "unclear"] as const;

export interface ObligationCandidate {
  fromAddress: string;
  toAddress?: string | null;
  classifiedIntent: string | null;
  /** Accepted so it can be RECORDED. It must not affect the decision. */
  classifiedConfidence?: number | null;
  /** Already-known suppression (unsubscribed). */
  suppressed?: boolean;
}

export type ObligationDecision =
  | { obligated: true }
  | { obligated: false; reason: "not_ack_terminating" | "system_sender" | "suppressed" };

/**
 * System / machine senders that must never create a human obligation.
 *
 * Stated as an explicit rule because the ticket asks for one, and because the
 * only two email-sourced rows `problem_reports` ever received were a test and a
 * Cloudflare Email Routing verification notice — a queue seeded entirely with
 * its own exhaust. Excluding by SENDER (not by content) keeps this decidable
 * and unguessable.
 */
export function isSystemSender(fromAddress: string): boolean {
  const addr = extractEmailAddress(fromAddress).toLowerCase();
  if (!addr) return true; // unparseable → not a person we can owe a reply to

  // Our own domain talking to itself: notify@, alert@, support@ self-loops.
  // Real customers never send FROM meetmeatthefair.com.
  if (addr.endsWith("@meetmeatthefair.com")) return true;

  // Machine senders by local-part convention. Deliberately anchored to the
  // local part rather than a substring search, so a human address that merely
  // contains "noreply" is not silently dropped.
  const localPart = addr.split("@")[0] ?? "";
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+.-]|$)/.test(localPart)) {
    return true;
  }

  // Cloudflare's own notification domain — the source of one of the two rows
  // problem_reports ever ingested by email.
  if (addr.endsWith("@notify.cloudflare.com")) return true;

  return false;
}

/** `"Name <a@b.c>"` → `"a@b.c"`; a bare address passes through. */
export function extractEmailAddress(raw: string): string {
  const angle = raw.match(/<([^>]+)>/);
  return (angle?.[1] ?? raw).trim();
}

/**
 * Does this inbound create an obligation?
 *
 * Note what is absent: any use of `classifiedConfidence`. That is the entire
 * point. The prior behaviour keyed human attention off classifier certainty,
 * which routed three pieces of SEO spam to a human and absorbed a real
 * customer's blocker in silence.
 */
export function decideObligation(candidate: ObligationCandidate): ObligationDecision {
  if (
    !candidate.classifiedIntent ||
    !(ACK_TERMINATING_INTENTS as readonly string[]).includes(candidate.classifiedIntent)
  ) {
    return { obligated: false, reason: "not_ack_terminating" };
  }
  if (isSystemSender(candidate.fromAddress)) {
    return { obligated: false, reason: "system_sender" };
  }
  if (candidate.suppressed) {
    // Unsubscribed: we must not email them, so we cannot owe them a reply.
    return { obligated: false, reason: "suppressed" };
  }
  return { obligated: true };
}

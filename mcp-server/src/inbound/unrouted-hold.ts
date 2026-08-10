/**
 * OPE-327 ruling 1 — hold-and-ask for UNROUTED mail, including unknown senders.
 *
 * When the project router can't place an email, the answer must be a question,
 * never a terminal "we couldn't understand your message". That failure mode is
 * what OPE-315 and OPE-325 each fixed one lane at a time; the router makes it
 * structurally unavailable.
 *
 * John's ruling extends hold-and-ask to senders we don't know — which is the
 * right call for a vendor emailing us for the first time, and an obvious way to
 * fill the queue with junk if left unguarded. Hence this module: the decision is
 * separated from the sending so the guard is testable without a mail server.
 *
 * ── Two independent limits, because they fail differently ───────────────────
 * PER-SENDER rate limit stops one stranger from generating unbounded holds.
 * EXPIRY stops holds accumulating forever when nobody answers — the queue's
 * size is bounded by (senders × limit) only if old holds also leave.
 *
 * A suppressed hold is NOT a dropped email. The mail is still stored and still
 * visible in the queue; what's suppressed is the outbound question. Dropping the
 * record would turn an abuse guard into data loss.
 */

/** Max open holds one unknown sender may have at once. Two is enough for an
 *  honest sender who mails twice before we reply, and far short of useful for
 *  anyone trying to flood the queue. */
export const MAX_HOLDS_PER_UNKNOWN_SENDER = 2;

/** Trusted senders get a higher ceiling — they have a track record, and their
 *  holds are the ones most likely to become real events. */
export const MAX_HOLDS_PER_TRUSTED_SENDER = 10;

/** Unanswered holds auto-expire after this long. 14 days is past any plausible
 *  reply window, so expiring one cannot lose a live conversation. */
export const HOLD_EXPIRY_DAYS = 14;

export type SenderTrust = "trusted" | "known" | "unknown";

export type HoldAction =
  /** Send the question and record the hold. */
  | "ask"
  /** Record nothing outbound — the sender is over their ceiling. */
  | "suppress";

export interface HoldDecision {
  action: HoldAction;
  reason: string;
  /** The ceiling that applied, so a log line explains itself. */
  limit: number;
}

/** How many open holds this sender is allowed. */
export function holdLimitFor(trust: SenderTrust): number {
  return trust === "trusted" ? MAX_HOLDS_PER_TRUSTED_SENDER : MAX_HOLDS_PER_UNKNOWN_SENDER;
}

/**
 * Should we send this sender a question?
 *
 * `openHoldCount` is their CURRENT open holds — expired ones must already be
 * excluded by the caller's query, or a sender who was noisy a month ago would
 * be silenced forever.
 */
export function decideUnroutedHold(input: {
  senderTrust: SenderTrust;
  openHoldCount: number;
}): HoldDecision {
  const limit = holdLimitFor(input.senderTrust);
  if (input.openHoldCount >= limit) {
    return {
      action: "suppress",
      limit,
      reason: `sender already has ${input.openHoldCount} open hold(s), limit ${limit} — question suppressed, email still queued for review`,
    };
  }
  return {
    action: "ask",
    limit,
    reason: `${input.openHoldCount} open hold(s) below limit ${limit}`,
  };
}

/**
 * Cutoff before which an unanswered hold is considered expired.
 *
 * Returned as a Date the caller compares `received_at` against, rather than
 * this module reaching for a clock — so the boundary is testable exactly.
 */
export function holdExpiryCutoff(now: Date, days: number = HOLD_EXPIRY_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Is this hold past its expiry? */
export function isHoldExpired(
  receivedAt: Date,
  now: Date,
  days: number = HOLD_EXPIRY_DAYS
): boolean {
  return receivedAt.getTime() < holdExpiryCutoff(now, days).getTime();
}

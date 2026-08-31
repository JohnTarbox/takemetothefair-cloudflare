/**
 * OPE-384 stage 3 — what happens to an ask AFTER it is sent.
 *
 * Stages 1 and 2 shipped a table with a partial unique index on
 * `(event_id) WHERE status IN ('queued','sent')`, which makes "never
 * double-ask" an invariant rather than a convention. They also shipped exactly
 * one status write in the entire repo: `queued -> sent`.
 *
 * Those two facts compose into a lockout. An organizer who never replies leaves
 * their attempt in `sent` forever, and the index that protects them from being
 * pestered then protects them from being asked a second time — permanently, and
 * silently, because a suppressed event simply stops appearing in the queue. The
 * first ask becomes the only ask we will ever make about that event.
 *
 * This module is the exit. It is pure: no database, no clock of its own, no
 * mail. The caller supplies `now`, which is what lets the timeout be tested at
 * a boundary instead of near one.
 */

/** Mirrors the `status` enum on `promoterOutreachAttempts`. */
export type PromoterOutreachStatus =
  | "queued"
  | "sent"
  | "replied"
  | "confirmed"
  | "no_response"
  | "bounced"
  | "refused";

/**
 * The legal moves. A status absent from a list is not merely discouraged —
 * `assertOutreachTransition` refuses it, so a caller cannot walk an attempt
 * backwards into a state its timestamps contradict.
 *
 * Two entries are deliberate and worth the sentence each:
 *
 *  - `queued -> refused` is an operator decision not to ask at all. It is NOT
 *    what the enablement gate writes: a gated send stays `queued`, keeping its
 *    composed prose drainable when the flag flips (stage 1's OPE-368 lesson).
 *  - `bounced` is terminal, not a route back to `queued`. A dead address is a
 *    promoter-enrichment problem; when enrichment finds a live one, the right
 *    artifact is a NEW attempt to a new address, not this row rewritten to
 *    claim we wrote somewhere we did not.
 */
export const PROMOTER_OUTREACH_TRANSITIONS: Readonly<
  Record<PromoterOutreachStatus, readonly PromoterOutreachStatus[]>
> = Object.freeze({
  queued: ["sent", "refused"],
  sent: ["replied", "bounced", "no_response"],
  // An ambiguous reply that goes to event-verification stays `replied`. That is
  // not a leak: `replied` is not an open status, so it suppresses nothing.
  replied: ["confirmed"],
  confirmed: [],
  no_response: [],
  bounced: [],
  refused: [],
});

export function canOutreachTransition(
  from: PromoterOutreachStatus,
  to: PromoterOutreachStatus
): boolean {
  return PROMOTER_OUTREACH_TRANSITIONS[from].includes(to);
}

/** Throws with both statuses named; the message is surfaced to the operator. */
export function assertOutreachTransition(
  from: PromoterOutreachStatus,
  to: PromoterOutreachStatus
): void {
  if (!canOutreachTransition(from, to)) {
    const legal = PROMOTER_OUTREACH_TRANSITIONS[from];
    throw new Error(
      `Illegal promoter-outreach transition ${from} -> ${to}. ` +
        (legal.length === 0 ? `${from} is terminal.` : `From ${from}, only: ${legal.join(", ")}.`)
    );
  }
}

/** Days of silence after which an ask is treated as unanswered. */
export const NO_RESPONSE_TIMEOUT_DAYS = 14;

const DAY_MS = 86_400_000;

export type OutreachTimeoutVerdict =
  | { action: "wait"; reason: string; daysRemaining?: number }
  | { action: "expire"; followUp: boolean; daysSilent: number };

/**
 * Should this attempt be closed as unanswered, and does a follow-up follow?
 *
 * The clock is `sentAt`, never `createdAt`, and the distinction is the whole
 * point. A `queued` attempt has a `createdAt` and no `sentAt` because the
 * enablement gate refused it — nobody was asked. Ageing that row into
 * `no_response` would record that an organizer ignored an email that never
 * left the building, and it would do so most often exactly while the rail was
 * switched off. Every "wait" below is a state in which no human has been given
 * anything to answer.
 *
 * The follow-up is capped by structure rather than by a counter: an attempt
 * created as a follow-up carries `followUpOf`, and only an attempt with
 * `followUpOf === null` earns one. So the ceiling is two asks per event per
 * cycle, and it cannot drift, because there is no number to increment wrongly.
 */
export function evaluateOutreachTimeout(input: {
  status: PromoterOutreachStatus;
  sentAt: Date | null;
  followUpOf: string | null;
  now: Date;
  timeoutDays?: number;
}): OutreachTimeoutVerdict {
  const timeoutDays = input.timeoutDays ?? NO_RESPONSE_TIMEOUT_DAYS;

  if (input.status !== "sent") {
    return {
      action: "wait",
      reason:
        input.status === "queued"
          ? "queued, not sent — nobody has been asked yet"
          : `status is ${input.status}, which is not awaiting a reply`,
    };
  }

  // `sent` with no `sentAt` is a data fault, not a timeout. Treating it as
  // aged-out would let a broken write silently manufacture no-response rows.
  if (!input.sentAt) {
    return { action: "wait", reason: "status is sent but sent_at is null — data fault" };
  }

  const daysSilent = (input.now.getTime() - input.sentAt.getTime()) / DAY_MS;
  if (daysSilent < timeoutDays) {
    return {
      action: "wait",
      reason: "still inside the reply window",
      daysRemaining: Math.max(0, timeoutDays - daysSilent),
    };
  }

  return { action: "expire", followUp: input.followUpOf === null, daysSilent };
}

/**
 * The order the sweep must write in — and it is the database's requirement,
 * not a preference.
 *
 * The partial unique index covers `queued` and `sent` together, so inserting
 * the follow-up while the original still reads `sent` violates it. The original
 * has to be closed to `no_response` first, and only then does the event have
 * room for a second ask.
 */
export const FOLLOW_UP_WRITE_ORDER = [
  "expire the original to no_response",
  "insert the follow-up as queued",
] as const;

/**
 * The single follow-up's copy, derived from the original ask.
 *
 * Deliberately shorter than the first email and it does not re-explain the
 * site. Someone who did not answer a long message is not owed a longer one.
 */
export function buildFollowUpDraft(input: {
  eventName: string;
  originalSubject: string;
  originalSentAt: Date;
}): { subject: string; body: string } {
  const sent = input.originalSentAt.toISOString().slice(0, 10);
  return {
    subject: `Re: ${input.originalSubject}`.slice(0, 200),
    body: `Hello,

I wrote on ${sent} to check this year's dates for ${input.eventName}, and I know how easily an email like that gets buried.

If the dates we have are right, a one-line reply is all we need. If they have moved, just tell me the correct ones and I will fix the listing.

If you would rather we not write again about this, say so and we will stop.

Thank you,
Meet Me at the Fair
`,
  };
}

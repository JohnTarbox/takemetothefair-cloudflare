/**
 * OPE-384 stage 6 — the outreach funnel, as arithmetic.
 *
 * Pure, and separate from the queries, for the reason stage 6 exists at all:
 * these numbers are the evidence that the rail works, so the rules for
 * computing them have to be reviewable and testable rather than embedded in a
 * SQL string nobody re-reads.
 *
 * ── The funnel is CUMULATIVE, and that is the whole difficulty ────────────
 *
 * `promoter_outreach_attempts.status` holds where an attempt is NOW, not every
 * stage it passed through. A confirmed attempt is no longer `sent`, but it was
 * sent — so counting `status = 'sent'` as "how many did we send" under-reports
 * by exactly the successes, and the funnel would show its conversion rate
 * falling as it improved.
 *
 * Each stage therefore counts every status at or past it.
 */

/** Terminal + in-flight statuses, in funnel order. */
export const OUTREACH_STATUSES = [
  "queued",
  "sent",
  "replied",
  "confirmed",
  "no_response",
  "bounced",
  "refused",
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

/** Statuses that prove a send actually happened. */
const SENT_OR_BEYOND: readonly OutreachStatus[] = [
  "sent",
  "replied",
  "confirmed",
  "no_response",
  "bounced",
];
/** Statuses that prove the organizer wrote back. */
const REPLIED_OR_BEYOND: readonly OutreachStatus[] = ["replied", "confirmed"];

export interface StatusCount {
  status: string;
  count: number;
}

export interface OutreachFunnel {
  queued: number;
  sent: number;
  replied: number;
  confirmed: number;
  noResponse: number;
  bounced: number;
  refused: number;
  /** replied / sent — null when nothing has been sent. */
  replyRate: number | null;
  /** confirmed / sent — the number that actually matters. */
  confirmRate: number | null;
  /** bounced / sent — dead addresses to route back to enrichment. */
  bounceRate: number | null;
}

function sumOf(rows: readonly StatusCount[], statuses: readonly string[]): number {
  return rows
    .filter((r) => statuses.includes(r.status))
    .reduce((a, r) => a + (Number(r.count) || 0), 0);
}

export function buildOutreachFunnel(rows: readonly StatusCount[]): OutreachFunnel {
  const at = (s: string) => sumOf(rows, [s]);
  const sent = sumOf(rows, SENT_OR_BEYOND);
  const replied = sumOf(rows, REPLIED_OR_BEYOND);
  const confirmed = at("confirmed");
  const bounced = at("bounced");

  // NULL, never 0, on an empty denominator. A rail that has sent nothing has
  // no reply rate; reporting 0% would read as "we asked and nobody answered",
  // which is the opposite of the truth and the more alarming of the two.
  const rate = (num: number, den: number) => (den === 0 ? null : num / den);

  return {
    queued: at("queued"),
    sent,
    replied,
    confirmed,
    noResponse: at("no_response"),
    bounced,
    refused: at("refused"),
    replyRate: rate(replied, sent),
    confirmRate: rate(confirmed, sent),
    bounceRate: rate(bounced, sent),
  };
}

/**
 * Median milliseconds from send to confirmation.
 *
 * Median, not mean: one organizer who replies four months later would drag a
 * mean past every useful reading, and "how long does this usually take" is the
 * question being asked.
 */
export function medianTimeToConfirmMs(durations: readonly number[]): number | null {
  const valid = durations.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid] : Math.round((valid[mid - 1] + valid[mid]) / 2);
}

export interface OutreachCoverage {
  /** Upcoming APPROVED events considered. */
  totalUpcoming: number;
  /** Events the queue says need nothing. */
  fullyConfirmed: number;
  needingConfirmation: number;
  /** Of those, how many we could actually email today. */
  contactable: number;
  blockedOnEnrichment: number;
  /** fullyConfirmed / totalUpcoming — the headline. */
  coverageRate: number | null;
  /**
   * THE leading quality metric: events asserting `dates_confirmed` with no
   * citation behind it. Should trend to zero once stage 5's gate lands; today
   * it is the size of the Dartmouth problem.
   */
  uncitedConfirmedDates: number;
}

export function buildOutreachCoverage(input: {
  totalUpcoming: number;
  needingConfirmation: number;
  contactable: number;
  uncitedConfirmedDates: number;
}): OutreachCoverage {
  const fullyConfirmed = Math.max(0, input.totalUpcoming - input.needingConfirmation);
  return {
    totalUpcoming: input.totalUpcoming,
    fullyConfirmed,
    needingConfirmation: input.needingConfirmation,
    contactable: input.contactable,
    blockedOnEnrichment: Math.max(0, input.needingConfirmation - input.contactable),
    coverageRate: input.totalUpcoming === 0 ? null : fullyConfirmed / input.totalUpcoming,
    uncitedConfirmedDates: input.uncitedConfirmedDates,
  };
}

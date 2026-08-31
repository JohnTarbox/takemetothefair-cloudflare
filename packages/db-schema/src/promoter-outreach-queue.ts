/**
 * OPE-384 stage 2 — which events need a promoter to confirm their details.
 *
 * Pure classification, deliberately. Every input is a value the caller already
 * read, so the rules are testable without a database and reviewable in one
 * screen — and the same rules can serve the MCP queue, a future cron, and the
 * stage-6 metrics without three interpretations of "needs confirmation".
 *
 * ── The worked example, and why "confirmed" is not evidence ───────────────
 *
 * Dartmouth Grange Fair 2026 carries `dates_confirmed = true` for Sep 11–12,
 * while the organizer's own site still shows the 2024 dates. The flag was set
 * by something that had no source for it. So an UNCITED `dates_confirmed` is
 * itself a reason to ask — treating the flag as evidence is precisely the
 * failure this rail exists to catch, and a queue that trusted it would skip
 * exactly the events most worth asking about.
 */

/** Why an event is in the queue. Ordered roughly by how much it matters. */
export type OutreachReason =
  | "dates_unconfirmed"
  | "dates_confirmed_uncited"
  | "dates_pending_official_tag"
  | "started_but_never_updated"
  | "missing_hours"
  | "missing_vendor_application";

/** Can we actually write to anyone about it? */
export type ContactStatus =
  | "contactable"
  | "placeholder_promoter"
  | "promoter_missing_email"
  | "no_promoter";

/**
 * The system placeholder used when a submission names no promoter.
 *
 * An event whose promoter is this has no organizer behind it to email — the
 * Dartmouth case exactly. It must route to promoter-enrichment rather than
 * emit an outreach task nobody can action.
 */
export const PLACEHOLDER_PROMOTER_NAME = "Community Suggestions";

export interface OutreachCandidateInput {
  startDate: Date | null;
  datesConfirmed: boolean | null;
  /** Count of `event_data_citations` rows backing a date field. */
  dateCitationCount: number;
  /** Parsed `events.tags`. */
  tags: readonly string[];
  lifecycleStatus: string | null;
  /** Count of `event_days` rows. */
  eventDayCount: number;
  commercialVendorsAllowed: boolean | null;
  vendorApplicationUrl: string | null;
  promoterName: string | null;
  promoterContactEmail: string | null;
}

export function classifyContact(input: {
  promoterName: string | null;
  promoterContactEmail: string | null;
}): ContactStatus {
  if (input.promoterName == null) return "no_promoter";
  if (input.promoterName.trim() === PLACEHOLDER_PROMOTER_NAME) return "placeholder_promoter";
  const email = input.promoterContactEmail?.trim();
  if (!email) return "promoter_missing_email";
  return "contactable";
}

/**
 * Every reason this event needs a promoter to confirm something.
 *
 * Returns ALL matching reasons rather than the first: an event missing both
 * its hours and its vendor-application link should say so, because one email
 * can ask for both and two separate asks to the same organizer is how a rail
 * like this gets people to stop replying.
 */
export function evaluateOutreachReasons(
  input: OutreachCandidateInput,
  now: Date
): OutreachReason[] {
  const reasons: OutreachReason[] = [];

  if (!input.datesConfirmed) {
    reasons.push("dates_unconfirmed");
  } else if (input.dateCitationCount === 0) {
    // Confirmed with nothing behind it — the Dartmouth shape. The flag says
    // somebody decided; the missing citation says nobody could show why.
    reasons.push("dates_confirmed_uncited");
  }

  if (input.tags.some((t) => t.trim().toLowerCase() === "dates-pending-official")) {
    reasons.push("dates_pending_official_tag");
  }

  // Started (or passed) while still marked SCHEDULED — nothing ever moved it,
  // which usually means nobody was watching rather than that it is running.
  if (
    input.startDate !== null &&
    input.startDate.getTime() <= now.getTime() &&
    input.lifecycleStatus === "SCHEDULED"
  ) {
    reasons.push("started_but_never_updated");
  }

  if (input.eventDayCount === 0) reasons.push("missing_hours");

  // Only ask about vendor applications where they are actually accepted.
  // Asking a fair that takes no vendors wastes the one reply we get.
  if (input.commercialVendorsAllowed && !input.vendorApplicationUrl?.trim()) {
    reasons.push("missing_vendor_application");
  }

  return reasons;
}

export interface OutreachQueueRow {
  eventId: string;
  reasons: OutreachReason[];
  contact: ContactStatus;
  /** True when an email could be sent today. */
  actionable: boolean;
  /** What to do first when it is not actionable. */
  blockedOn: "promoter_enrichment" | null;
}

/**
 * Build the queue row for one candidate, or null when nothing is wrong.
 *
 * A row with reasons but no contact is STILL returned, marked non-actionable
 * and blocked on enrichment. Dropping it would hide the largest and most
 * fixable segment — the ticket's own worked example is one — and make the
 * queue read as "few events need confirmation" when the truth is "we cannot
 * reach anyone about most of them".
 */
export function buildOutreachQueueRow(
  eventId: string,
  input: OutreachCandidateInput,
  now: Date
): OutreachQueueRow | null {
  const reasons = evaluateOutreachReasons(input, now);
  if (reasons.length === 0) return null;
  const contact = classifyContact(input);
  const actionable = contact === "contactable";
  return {
    eventId,
    reasons,
    contact,
    actionable,
    blockedOn: actionable ? null : "promoter_enrichment",
  };
}

/**
 * OPE-405 item 2 — roster SUSPICION from the prose, independent of the attachment.
 *
 * Inbound `34b06089` ("Fwd: Artisan Fair", 2026-08-18) was scored `new_event`
 * at 0.90 while carrying three simultaneous roster tells: the literal sentence
 * "I am attaching the list for Saturday's Fair", a forwarded distribution list
 * of ~21 exhibitor addresses, and a municipal Recreation Director as the
 * original sender. Any one of those should have raised suspicion; all three
 * together produced "this is a new event, ask the sender for its details" —
 * for an event already listed APPROVED.
 *
 * ── Why this does not add a `roster` intent ─────────────────────────────
 *
 * The taxonomy is nine intents with a lot of consumers, and widening an enum
 * here has bitten this repo before. It is also not obviously the right model:
 * a forwarded roster for an existing fair genuinely *is* event-shaped mail.
 * What was missing is not a different label — it is a recorded signal that
 * something roster-ish arrived and nothing captured it.
 *
 * So this is a pure, deterministic detector (the same shape as the OPE-278
 * list-broker screen) whose output is logged and flags the row for review. It
 * changes no routing and no reply. It makes the miss VISIBLE and countable,
 * which is the precondition for deciding whether routing should change.
 */

/** A distribution list this size is a mailing to exhibitors, not a normal Fwd. */
const MIN_DISTRIBUTION_ADDRESSES = 8;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * "I am attaching the list", "please see the attached vendor list", "here is
 * our lineup". Anchored on attach/enclosed/here-is + a roster noun, so ordinary
 * "attached is our flyer" does not trip it.
 */
const ATTACHING_A_LIST_RE =
  /\b(?:attach(?:ing|ed|es)?|enclos(?:ing|ed)|here(?:'s| is)|see)\b[^.!?\n]{0,60}?\b(?:list|roster|line[-\s]?up|vendors?|exhibitors?|artisans?|crafters?|participants?)\b/i;

/**
 * Role/institutional senders who mail rosters: town recreation departments,
 * chambers of commerce, festival committees. Matched on the local part or the
 * domain, because both carry the signal.
 */
const ORGANIZER_LOCALPART_RE =
  /^(?:recreation|rec|parks|chamber|events?|festival|artfestival|craftfair|market|info|admin|office)\b/i;
const ORGANIZER_DOMAIN_RE = /\.(?:gov|us)$|chamber|recreation|townof|cityof/i;

export interface RosterTells {
  /** Prose says a list is attached. */
  attachingAList: boolean;
  /** A forwarded exhibitor distribution list. */
  distributionList: boolean;
  /** Count behind `distributionList`, for the log line. */
  addressCount: number;
  /** Sender (or a forwarded sender in the body) looks institutional. */
  organizerSender: boolean;
  /** Every tell that fired, for logging and for a countable metric. */
  matched: string[];
}

function looksLikeOrganizer(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return ORGANIZER_LOCALPART_RE.test(local) || ORGANIZER_DOMAIN_RE.test(domain);
}

/**
 * Detect roster tells in an inbound email. Pure and deterministic.
 *
 * `fromAddress` is the forwarding contributor, which is usually NOT the
 * organizer — the organizer appears inside the forwarded body. So the sender
 * check runs over the body's addresses as well as the envelope sender.
 */
export function detectRosterTells(
  subject: string | null | undefined,
  bodyText: string | null | undefined,
  fromAddress: string | null | undefined
): RosterTells {
  const body = bodyText ?? "";
  const haystack = `${subject ?? ""}\n${body}`;

  const addresses = Array.from(new Set((body.match(EMAIL_RE) ?? []).map((a) => a.toLowerCase())));

  const attachingAList = ATTACHING_A_LIST_RE.test(haystack);
  const distributionList = addresses.length >= MIN_DISTRIBUTION_ADDRESSES;
  const organizerSender =
    (fromAddress ? looksLikeOrganizer(fromAddress) : false) || addresses.some(looksLikeOrganizer);

  const matched: string[] = [];
  if (attachingAList) matched.push("attaching-a-list");
  if (distributionList) matched.push(`distribution-list:${addresses.length}`);
  if (organizerSender) matched.push("organizer-sender");

  return {
    attachingAList,
    distributionList,
    addressCount: addresses.length,
    organizerSender,
    matched,
  };
}

/**
 * Is this worth flagging when no roster was actually captured?
 *
 * One tell is enough. The filed complaint is precisely that three fired at
 * once and nothing happened, and a single-tell threshold is only noisy if it
 * drives an action — this drives a log line and a review flag, and the review
 * flag is already set by every roster that IS captured.
 */
export function hasRosterSuspicion(tells: RosterTells): boolean {
  return tells.matched.length > 0;
}

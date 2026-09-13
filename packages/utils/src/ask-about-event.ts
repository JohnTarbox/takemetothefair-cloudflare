/**
 * OPE-851 Scope A — a contact link that carries the event with it.
 *
 * ## The defect
 *
 * On 2026-09-08 a fair-goer emailed `hello@` asking *"is it ok to have a
 * well-behaved dog on a leash ?"*. The mail arrived with `parsed_url` null,
 * `match_basis` `none`, and the briefing's warning "No event matched from the
 * subject or a parsed URL" — so nobody could tell which of ~13 fairs opening in
 * the next three weeks he meant. The only recovery was to write back and ask.
 *
 * He was not confused: we outrank several of these fairs on their own names
 * (30,387 impressions on one event page in 90 days at average position 6), we
 * call ourselves "always current", and our Visitor's Guides answer exactly this
 * genre of question in an unhedged voice. The site invites the question and
 * then strips the one fact needed to answer it.
 *
 * ## Why the URL goes in the BODY and not only the subject
 *
 * The inbound pipeline populates `parsed_url` from `extractAllUrls` over the
 * email body. A subject line alone does not reach it. So the canonical event
 * URL is placed on its own line at the end of the body, after a `---` fence, in
 * a shape a sender will naturally type above rather than delete.
 *
 * That single line is the entire mechanism: with it, `parsed_url` populates,
 * the matcher fires, and `vendor_inquiry_briefing.matchedEvent` is non-null
 * when the mail lands. Today all three are empty.
 *
 * ⚠️ Deliberately NOT a form. A `mailto:` keeps the sender in their own client
 * with their own address, needs no new endpoint, no spam surface and no
 * storage, and this ticket is explicit that one data point does not justify a
 * build. If this class of question recurs, a form is the next step, not this.
 */

/** Where visitor questions go. Matches the address on /contact. */
export const ASK_ABOUT_EVENT_ADDRESS = "hello@meetmeatthefair.com";

export interface AskAboutEventInput {
  /** The event's display name, e.g. "Litchfield Fair". */
  eventName: string;
  /** Four-digit year, when the event has a start date. */
  year?: number | null;
  /** Absolute canonical URL of the event page. */
  canonicalUrl: string;
}

/**
 * Build the `mailto:` href for "Ask about this fair".
 *
 * Returns null when there is no canonical URL to carry — a link without the URL
 * would reproduce the exact defect this exists to fix, so it is better to
 * render nothing than to render a link that arrives unattributable.
 */
export function buildAskAboutEventMailto(input: AskAboutEventInput): string | null {
  const url = input.canonicalUrl?.trim();
  if (!url) return null;

  const name = input.eventName?.trim() || "this event";
  // OPE-985 — many event names already end in their year ("PTTF Holiday Craft
  // Fair 2026"), which rendered as "… 2026 2026" in every reader's subject line.
  const year = input.year ? String(input.year) : "";
  const subject =
    year && !new RegExp(`\\b${year}$`).test(name)
      ? `Question about ${name} ${year}`
      : `Question about ${name}`;

  // Two blank lines so the sender's cursor lands above the fence and their
  // text does not run into it; the fence makes the trailing line read as
  // machine context rather than something to edit out.
  const body = `\n\n---\n${url}`;

  return `mailto:${ASK_ABOUT_EVENT_ADDRESS}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

/**
 * Lines a mail client appends on its own. They carry no question.
 * Anchored per line so "sent from my …" inside a sentence is untouched.
 */
const CLIENT_SIGNATURE_LINE = /^\s*(sent from my .{1,40}|get outlook for .{1,20})\s*$/i;

/**
 * OPE-985 — true when an inbound body is this template and nothing else: the
 * `---` fence and one meetmeatthefair.com event URL, with only whitespace (and
 * at most a client-added "Sent from my iPhone") around them.
 *
 * On 2026-09-13 a reader sent the prefilled body untouched. The subject alone
 * classified as `correction` at 0.9, the standard acknowledgement thanked her
 * seven seconds later for a question nobody could read, and the row parked
 * waiting for an admin decision with nothing in it.
 *
 * Deliberately narrow. Prose ANYWHERE — above the fence, or below the URL, where
 * two of the four real senders typed — makes this false. A quoted `> ---` from
 * a client that re-indents the tail still counts as the template.
 */
export function isBlankAskAboutEventBody(body: string | null | undefined): boolean {
  if (!body) return false;
  const lines = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, "").trim())
    .filter((l) => l.length > 0 && !CLIENT_SIGNATURE_LINE.test(l));
  if (lines.length !== 2) return false;
  const [fence, url] = lines;
  return fence === "---" && /^https?:\/\/(?:www\.)?meetmeatthefair\.com\/events\/\S+$/i.test(url);
}

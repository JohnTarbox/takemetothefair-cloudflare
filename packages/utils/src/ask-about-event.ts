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
  const subject = input.year ? `Question about ${name} ${input.year}` : `Question about ${name}`;

  // Two blank lines so the sender's cursor lands above the fence and their
  // text does not run into it; the fence makes the trailing line read as
  // machine context rather than something to edit out.
  const body = `\n\n---\n${url}`;

  return `mailto:${ASK_ABOUT_EVENT_ADDRESS}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

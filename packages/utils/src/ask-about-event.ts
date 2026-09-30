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

/**
 * OPE-985 A1 (ruled by John 2026-09-20) — the prompt that says where to type.
 *
 * The body opened with two blank lines, and of the readers who typed anything,
 * two typed BELOW the URL and one above the fence. Nobody used the blank lines:
 * the template never said where to type, so now it does.
 *
 * Exported because `isBlankAskAboutEventBody` must know this line, or a template
 * that adds a line the detector does not recognise would silently stop detecting
 * blanks — which is worse than the defect. The two must ship together.
 */
export const ASK_ABOUT_EVENT_LABEL = "Your question:";

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

  // OPE-985 A1 — a visible label, then room to type, then the fence. The URL
  // stays on its own line after the fence so `parsed_url` still populates
  // (OPE-977's roundtrip); the fence keeps it reading as machine context.
  const body = `${ASK_ABOUT_EVENT_LABEL}\n\n\n---\n${url}`;

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
 *
 * OPE-985 A1: the `Your question:` label is part of the template, so a body that
 * is only the label plus the fence and URL is still blank. A reader who types
 * ON the label line ("Your question: can I bring a dog?") has typed prose, and
 * that line no longer equals the label — so it is correctly NOT blank.
 */
export function isBlankAskAboutEventBody(body: string | null | undefined): boolean {
  if (!body) return false;
  const lines = readerLines(body);
  if (lines.length !== 2) return false;
  const [fence, url] = lines;
  return fence === "---" && /^https?:\/\/(?:www\.)?meetmeatthefair\.com\/events\/\S+$/i.test(url);
}

/**
 * The lines a human actually typed, with the machinery removed: quote markers,
 * blank lines, client signatures, and the `Your question:` label.
 *
 * Quote markers are STRIPPED, not dropped, and the fence and URL are kept —
 * `isBlankAskAboutEventBody` needs both to recognise a template whose tail a
 * client re-indented as `> ---`. Callers that want only the reader's own words
 * use `readerProse`, which drops quoted lines outright.
 */
function readerLines(body: string): string[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, "").trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !CLIENT_SIGNATURE_LINE.test(l) &&
        l.toLowerCase() !== ASK_ABOUT_EVENT_LABEL.toLowerCase()
    );
}

/** Our own event URL, anywhere in a line. */
const OUR_EVENT_URL = /https?:\/\/(?:www\.)?meetmeatthefair\.com\/events\/\S+/i;

/**
 * What the reader wrote in their own voice: template machinery gone, and
 * QUOTED lines gone too.
 *
 * Dropping quoted lines matters more than it looks. Our own notification mail
 * asks questions ("Why: no venue we have geocoded…"), so a reply that quotes it
 * carries our question marks, not the sender's. Unquoting instead of dropping
 * would let our own prose vote on what the sender meant.
 *
 * Empty string when they typed nothing — the blank case OPE-985 owns.
 */
export function readerProse(body: string | null | undefined): string {
  if (!body) return "";
  const unquoted = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
  return readerLines(unquoted)
    .filter((l) => l !== "---" && !OUR_EVENT_URL.test(l))
    .join(" ")
    .trim();
}

/**
 * Language that claims something on the listing is WRONG.
 *
 * Deliberately the loose set from `intent-fastpath.hasMultiIntentOrSpecialSignal`,
 * and deliberately loose in THIS direction: a false positive here means a
 * message keeps today's correction handling, which is the behaviour that already
 * ships. A false negative would route a genuine correction to the question
 * branch, which is the one outcome that would make this change a regression.
 * When in doubt, it is a correction.
 */
const CORRECTION_LANGUAGE =
  /\b(wrong|incorrect|should be|isn'?t it|not right|out of date|outdated|cancell?ed|has changed|no longer|appears to be|needs? updating|fix(?: this)?|change the)\b/i;

/** An opening word that makes a line a question even with no question mark. */
const INTERROGATIVE_OPENER =
  /^(can|could|do|does|did|is|are|was|were|will|would|should|may|might|have|has|any|what|when|where|who|why|how|which)\b/i;

/**
 * OPE-1085 — true when a body reaching the `correction` lane is a reader
 * ASKING something, not reporting an error.
 *
 * ## Why this exists
 *
 * The classifier returns `correction` on every arrival of this template where it
 * has run (6 of 6, 2026-09-13 → 09-19). An ablation against the real model
 * showed why: neither cue does it alone — our `Question about …` subject alone
 * reads `support` at 0.90, and our own event URL in the body alone reads
 * `support` at 0.90 — but TOGETHER they read `correction` at 0.85, scraping over
 * a `>= 0.85` gate with zero margin. A foreign URL with the same subject stays
 * `support`, so it is specifically our host. Both halves of the conjunction are
 * ours: we built the template that supplies them.
 *
 * The model is not confused about the words. `fbd5b1fc`'s stored rationale reads
 * *"asking about wheelchair rentals at a specific event, implying a need for
 * updated or corrected information"* — it read the question correctly and then
 * had nowhere to put it, because the taxonomy has no "reader is asking about a
 * listing" class and defines `support` as *general* how-to.
 *
 * ## What this does NOT do
 *
 * It does not reclassify. The row still travels the correction lane and still
 * records a `correction` intent, because that is what the classifier said and
 * rewriting its verdict would hide the defect from the accuracy dashboard. This
 * only decides what the READER is told — see the branch in
 * `email-handlers/correction.ts`.
 *
 * ## Why it requires BOTH halves of the template
 *
 * It fires only on our subject AND our event URL — the same conjunction the
 * ablation identified — rather than on any question reaching this lane. That is
 * not caution for its own sake: checked against all 37 `correction` rows in
 * prod, the looser "any interrogative with no correction language" rule also
 * caught `46af4630`, a reader from Canada who wrote *"Your website states the
 * parade is Friday October 2 … other websites state Thursday October 1 … could
 * you please clarify"*. That is a genuine date correction, phrased politely as
 * a question, and it belongs in the correction lane. Requiring the template
 * excludes it, because he wrote to us directly rather than through the mailto.
 *
 * Measured blast radius on the same 37 rows: 4 of the 7 template arrivals fire,
 * one of which (`6a9a7373`) already receives this treatment today by accident,
 * having landed at 0.82 and fallen below the gate. So 3 rows change behaviour,
 * and no non-template row changes at all.
 */
export function isListingQuestion(input: {
  subject: string | null | undefined;
  body: string | null | undefined;
}): boolean {
  // Half one: the subject this template generates, past any Re:/Fwd: prefixes.
  const subject = (input.subject ?? "").replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
  if (!/^question about .+/i.test(subject)) return false;
  // Half two: our own event URL in the body. A foreign URL with the same
  // subject classifies `support` and never reaches this lane.
  if (!OUR_EVENT_URL.test(input.body ?? "")) return false;

  const prose = readerProse(input.body);
  if (!prose) return false; // blank — OPE-985 owns it, and runs earlier
  if (CORRECTION_LANGUAGE.test(prose)) return false;
  return prose.includes("?") || INTERROGATIVE_OPENER.test(prose);
}

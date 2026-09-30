/**
 * OPE-452 — a reply's quoted region is OUR text, not the sender's.
 *
 * Emma Welford replied to our "Incorrect Listing" thread with three
 * organizer-confirmed show dates. Her message contains no URL at all. The
 * inbound row nonetheless recorded:
 *
 *     parsed_url = https://meetmeatthefair.com/promoters/paradise-city-arts-festivals
 *
 * That URL appears only inside the quoted copy of OUR OWN outbound reply,
 * beneath her text. `pickPrimaryUrl` scans the whole body, so on any reply it
 * can attribute a link we sent to the person answering us — and the more
 * helpful our original reply was, the more of our links it has to choose from.
 *
 * ── The distinction that makes this safe ──────────────────────────────────
 *
 * A FORWARD and a REPLY look superficially alike and must be treated in
 * opposite ways:
 *
 *   forward — the quoted material IS the submission. "John forwards an
 *             organizer's email" is the single most common intake shape here,
 *             and `stripForwardedPreamble` exists to protect it.
 *   reply   — the quoted material is a transcript of what we already said.
 *             Nothing in it is new information from the sender.
 *
 * So this cuts ONLY on reply-attribution markers, never on a forwarded
 * delimiter. Getting that backwards would silently discard the payload of most
 * of our real submissions, which is a far worse failure than the one being
 * fixed.
 *
 * ── And why it refuses to cut everything ─────────────────────────────────
 *
 * Bottom-posters write BELOW the quote. If the text above the attribution line
 * is essentially empty, the sender's words are further down and cutting there
 * would throw away the entire message — reproducing, deliberately, the
 * empty-body failure this ticket was filed about. In that case we leave the
 * body untouched and accept the weaker URL attribution.
 */

/**
 * Reply attribution lines, in the forms real clients emit.
 *
 * Deliberately anchored and bounded. An unbounded `.*wrote:` would match prose
 * like "…as the organizer wrote:" in the middle of a legitimate submission.
 */
const REPLY_MARKERS: RegExp[] = [
  // Gmail / Apple Mail: "On Thu, Aug 13, 2026 at 7:47 PM Someone <a@b> wrote:"
  // The name/address run can wrap across lines, hence [\s\S] with a bound.
  /(^|\n)[ \t]*On[\s\S]{0,200}?wrote:[ \t]*(\n|$)/,
  // Outlook / older clients.
  /(^|\n)[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*(\n|$)/i,
  /(^|\n)[ \t]*_{5,}[ \t]*(\n|$)/,
  // Outlook header block that follows a reply with no attribution line.
  /(^|\n)[ \t]*From:[ \t].{0,200}\n[ \t]*Sent:[ \t]/i,
  // OPE-1123 — the same header block as Yahoo / webmail clients write it:
  // `From:` then `To:` / `Date:` / `Cc:` on the next line (inbound 09eccd4f).
  // A Gmail forward has the same shape, but under a FORWARD_MARKER, which the
  // guard below checks first.
  /(^|\n)[ \t]*From:[ \t].{0,200}\n[ \t]*(To|Date|Cc):[ \t]/i,
];

/** A forwarded delimiter — never cut here; the forward IS the content. */
const FORWARD_MARKER = /(^|\n)[\s>]*-{2,}[ \t]*Forwarded message[ \t]*-{2,}/i;

/** Minimum characters that must remain, or we assume a bottom-post and keep everything. */
const MIN_REMAINDER = 20;

/**
 * Return only the sender's NEW text, dropping a quoted reply transcript.
 * Returns the input unchanged when there is no reply marker, when the marker
 * belongs to a forwarded message, or when cutting would leave nothing.
 */
export function stripQuotedReply(bodyText: string): string {
  if (!bodyText) return bodyText;

  // A forwarded message anywhere above the earliest reply marker means the
  // quoted block is payload, not transcript. Leave it alone.
  const fwd = bodyText.search(FORWARD_MARKER);

  let cutAt = -1;
  for (const re of REPLY_MARKERS) {
    const idx = bodyText.search(re);
    if (idx >= 0 && (cutAt === -1 || idx < cutAt)) cutAt = idx;
  }
  if (cutAt < 0) return bodyText;
  if (fwd >= 0 && fwd <= cutAt) return bodyText;

  const head = bodyText.slice(0, cutAt).trim();
  // Bottom-post guard: the sender wrote below the quote, so cutting here would
  // discard their entire message.
  if (head.length < MIN_REMAINDER) return bodyText;
  return head;
}

/**
 * True when the body contains a quoted reply transcript we would strip. Useful
 * for telemetry — "how often is this firing?" — without re-running the cut.
 */
export function hasQuotedReply(bodyText: string): boolean {
  return stripQuotedReply(bodyText) !== bodyText;
}

/** A forward subject — `Fwd:` / `FW:` — whose quoted block is the payload. */
const FORWARD_SUBJECT = /^\s*(fwd?|fw)\s*:/i;

/**
 * A date the LIVE text names: "October 11th", "Oct. 3", "9/26". Enough to say
 * the sender's own words describe an event, not to parse one.
 */
const DATE_SIGNAL =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}\b/i;

/**
 * OPE-1123 — the prose the submit pipeline should extract events FROM.
 *
 * A reply's quoted transcript is prior correspondence, not a second source.
 * Inbound 09eccd4f's live text asked about Hackmatack's Oct 11 fall festival;
 * the four-month-old message quoted beneath it described the June 21 fair, and
 * the extractor minted a row for that already-past event.
 *
 * This is the ONE place quoting is cut on the submission path, and it is
 * stricter than `stripQuotedReply`, because here a wrong cut loses the
 * submission itself — forwarding an organizer's email is the most common intake
 * shape. So the transcript is dropped only when ALL hold:
 *
 *   - `stripQuotedReply` found a reply marker (never under a forward delimiter);
 *   - the subject is not a forward (`Fwd:` / `FW:`) — an Outlook forward has
 *     no delimiter, only the header block, and its quoted body is the payload;
 *   - the live text itself names a date, so it describes an event on its own.
 *
 * Otherwise the full body is returned, exactly as before.
 */
export function submissionProseText(bodyText: string, subject: string | null | undefined): string {
  if (!bodyText) return bodyText;
  if (FORWARD_SUBJECT.test(subject ?? "")) return bodyText;
  const live = stripQuotedReply(bodyText);
  if (live === bodyText) return bodyText;
  if (!DATE_SIGNAL.test(live)) return bodyText;
  return live;
}

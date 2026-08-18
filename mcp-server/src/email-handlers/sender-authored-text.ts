/**
 * OPE-466 — separate what the SENDER wrote from what WE wrote.
 *
 * The `unsubscribe` handler removes a subscriber with no confirmation step,
 * acting on nothing but the classifier's verdict. Two probe emails sent during
 * the OPE-455 investigation were classified `unsubscribe` and acked, and the
 * only intent-bearing English prose in either was **our own CAN-SPAM footer**,
 * which `send_test_email` appends to every send:
 *
 *     --
 *     You're receiving this because …
 *     Unsubscribe: https://meetmeatthefair.com/unsubscribe/…
 *     Meet Me at the Fair · 18 Main St, …
 *
 * A classifier reading that body sees the word "Unsubscribe" attached to a URL
 * and concludes the sender wants out. It is not an unreasonable read — it is
 * simply attributing our text to them.
 *
 * ── The bound that matters ───────────────────────────────────────────────
 *
 * A control probe settles how far this goes. The SAME footer, from the SAME
 * sender, under an unambiguous authored body ("Please add our craft fair…")
 * classified `new_event` correctly. So the footer wins only when nothing else
 * in the body competes — it does not override real content. This module exists
 * to remove even that narrow case, not to fight the classifier.
 *
 * Same family as OPE-452, which found a URL scraped out of our own quoted
 * signature and shipped `stripQuotedReply` for it. That helper handles the
 * REPLY transcript; this one adds the trailing signature/footer block, and
 * composes the two.
 */

import { stripQuotedReply } from "./strip-quoted-reply.js";

/**
 * RFC 3676 §4.3 signature delimiter: a line containing exactly `--` (the
 * standard permits a trailing space, and plenty of clients emit it without).
 * Our own footer uses this form, as do most mail clients' signatures.
 *
 * Anchored to a whole line so a prose em-dash or a `--force` in a body cannot
 * trigger it.
 */
const SIG_DELIMITER = /(^|\n)[ \t]*--[ \t]*(\n|$)/;

/**
 * Drop a trailing signature / footer block.
 *
 * Cuts at the LAST delimiter, not the first: a quoted chain can carry several,
 * and the sender's own words are above all of them.
 *
 * ── No bottom-post guard here, deliberately ─────────────────────────────
 *
 * `stripQuotedReply` refuses to cut when little text remains above the marker,
 * because people really do write BELOW a quote and cutting there would discard
 * their whole message. That reasoning does not carry over: nobody bottom-posts
 * below their own signature delimiter — the delimiter's entire meaning is
 * "everything after this is not the message."
 *
 * So an empty remainder is not a sign the cut was wrong. It is the honest
 * answer that the sender wrote nothing, which is precisely the case OPE-466 is
 * about: a body that reduces to our own footer must yield NO sender text, not
 * fall back to handing the footer to a matcher.
 */
export function stripSignatureBlock(bodyText: string): string {
  if (!bodyText) return bodyText;
  let cutAt = -1;
  // No lastIndexOf for regexes; walk forward keeping the last match.
  let from = 0;
  for (;;) {
    const rest = bodyText.slice(from);
    const idx = rest.search(SIG_DELIMITER);
    if (idx < 0) break;
    cutAt = from + idx;
    from = cutAt + 1;
  }
  if (cutAt < 0) return bodyText;
  return bodyText.slice(0, cutAt).trim();
}

/**
 * The sender's own words: quoted reply transcript and trailing signature
 * removed. Both steps fail safe, so this is never emptier than the caller can
 * afford — in the worst case it returns the body unchanged.
 */
export function senderAuthoredText(bodyText: string | null | undefined): string {
  return stripSignatureBlock(stripQuotedReply(bodyText ?? ""));
}

/**
 * Phrases that constitute an actual request to be removed.
 *
 * Deliberately a small, explicit list rather than a model call. This runs on a
 * body the classifier ALREADY called `unsubscribe`; its only job is to confirm
 * the sender said so themselves. A second fuzzy judgement would just move the
 * false positive rather than remove it.
 *
 * `stop` is matched only as a standalone word/line — the carrier convention —
 * because "stop by our booth" is ordinary prose in this inbox.
 */
const UNSUBSCRIBE_PHRASES: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bopt[- ]?out\b/i,
  /\bstop (sending|emailing|the emails?)\b/i,
  /\bno longer wish to (receive|get)\b/i,
  /\bdon'?t (want|wish) to (receive|get)\b/i,
  /(^|\n)[ \t]*stop[ \t.!]*(\n|$)/i,
];

/**
 * Did the sender ask, in their own text, to be unsubscribed?
 *
 * Returns the matched phrase so the caller can record WHY someone was removed —
 * a removal nobody can explain is not answerable when it is disputed.
 */
export function findUnsubscribeRequest(bodyText: string | null | undefined): string | null {
  const authored = senderAuthoredText(bodyText);
  if (!authored) return null;
  for (const re of UNSUBSCRIBE_PHRASES) {
    const m = authored.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

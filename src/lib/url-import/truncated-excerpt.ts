/**
 * Detection of CMS "excerpt" truncation in text we are about to store as an
 * event description.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * OPE-537, second failure. After Browser Rendering started working, the
 * Vermont Crafters Expo import stored a description that was byte-identical
 * to the page's `og:description`, `[…]` included:
 *
 *   "…the Vermont Crafters Expo. This is not a traditional craft […]"
 *
 * The page continues: "…craft FAIR. Rather than featuring vendors selling
 * finished handmade products, the Expo focuses on the tools, materials,
 * education, and resources that help people create."
 *
 * WordPress cut the excerpt one word before the sentence turns. The stored
 * text is not false — every word of it is on the page — but it is severed at
 * exactly the point where the event's premise inverts, and it reads as
 * complete. That is the same harm as the fabricated description this ticket
 * was filed over, arrived at from the opposite direction: the first was
 * invented and wrong, this one is quoted and misleading.
 *
 * ── The tradeoff, stated ─────────────────────────────────────────────────
 * A trailing ellipsis is not PROOF of truncation — a description could end
 * in one for effect. We drop it anyway. A missing description is recoverable
 * by any later pass; a truncated one is indistinguishable from a complete
 * one forever after, because nothing downstream knows the tail was cut.
 * False positives cost us a field. False negatives cost us the meaning.
 */

/**
 * Markers a CMS leaves when it cuts prose to a fixed length.
 *
 * Bracketed forms (`[…]`, `[...]`) are unambiguous — no author writes them.
 * Bare trailing ellipses and "read more" tails are judged the same way for
 * the reason in the header: the asymmetry of the two errors, not equal
 * confidence in the two signals.
 *
 * `&hellip;` is not listed because callers decode entities before this runs
 * (`extractMetadata` applies `decodeHtmlEntities`), so it arrives as `…`.
 */
const TRUNCATION_MARKERS = [
  /\[\s*(?:…|\.\.\.|\. \. \.)\s*\]\s*$/u,
  /(?:…|\.\.\.)\s*$/u,
  /\b(?:read|continue)\s+(?:more|reading)\s*(?:…|\.\.\.|»|>>)?\s*$/iu,
];

/**
 * True when `value` looks like a CMS excerpt rather than complete prose.
 *
 * ⚠️ Must be called on the RAW value, BEFORE any length-capping sanitizer.
 * `sanitizeString` appends its own "..." when it truncates at maxLength, so
 * running this afterwards would classify every long-but-complete description
 * as an excerpt and null out the good ones — inverting the fix.
 */
export function isTruncatedExcerpt(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const str = value.trim();
  if (str === "") return false;
  return TRUNCATION_MARKERS.some((re) => re.test(str));
}

/**
 * OPE-1107 — the text/plain alternative for a newsletter whose caller supplied
 * only HTML.
 *
 * The derivation this replaces was `replace(/<[^>]+>/g, " ")` then collapse all
 * whitespace. On the first vendor broadcast that produced, verbatim in the
 * received text part: "Sep 26 &middot; MA", "Authors &amp; book-trade sellers",
 * "Details &rarr;" — every entity left raw, the whole issue on ONE line, and
 * every link gone, so a text-only reader got a newsletter with no way to reach
 * any show. It had been doing the same to all 65 weekend subscribers every
 * Friday since 2026-07-16; nobody reads the text part until somebody does.
 *
 * Order matters:
 *   1. drop non-content blocks (head/style/script);
 *   2. turn links into "label (url)" while the href is still attached;
 *   3. turn block boundaries into line breaks;
 *   4. strip the remaining tags;
 *   5. decode entities ONCE, last — decoding before stripping would turn an
 *      escaped `&lt;b&gt;` in the copy into a tag and delete it.
 */
import { decodeHtmlEntities } from "@takemetothefair/utils";

const BLOCK_CLOSE =
  /<\/(p|div|ul|ol|h[1-6]|tr|table|thead|tbody|section|article|header|footer|blockquote)\s*>/gi;

export function htmlToPlainText(html: string): string {
  let s = html;

  s = s.replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, "");

  s = s.replace(
    /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, _q: string, href: string, inner: string) => {
      const label = inner
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      // The href is decoded here because its `&amp;` is attribute escaping, not
      // copy; the label is left for the single decode pass at the end.
      const url = decodeHtmlEntities(href.trim()).replace(/^mailto:/i, "");
      if (!label) return url;
      // A link whose text IS its address needs saying once, not twice.
      if (decodeHtmlEntities(label) === url) return label;
      return `${label} (${url})`;
    }
  );

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(BLOCK_CLOSE, "\n");
  s = s.replace(/<[^>]+>/g, "");

  s = decodeHtmlEntities(s).replace(/ /g, " ");

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

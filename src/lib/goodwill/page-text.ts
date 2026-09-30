/**
 * OPE-988 — small, dependency-free readers over a fetched HTML page, shared by
 * the source-agreement check and the domain-takeover detector.
 *
 * Kept apart from url-health.ts on purpose: that module's `visibleText` is
 * pinned by OPE-860/979 tests and is being extended concurrently (OPE-987), and
 * these readers need two things it deliberately does not do — decode entities
 * (the Fort Wayne specimen writes `Sept. 19th &amp; 20th`, and a town written
 * `Coeur d&#8217;Alene` must still match) and read the `<head>` (title, meta
 * `geo.region`, `lang`), which `visibleText` strips.
 */
import { visibleText } from "./url-health";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "...",
  copy: "(c)",
};

/** Decode the entities organizer CMSes actually emit: named, decimal, hex. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function pageTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

/** Content of `<meta name|property|http-equiv="key" content="…">`, either attribute order. */
export function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(
    `<meta\\b[^>]*(?:name|property|http-equiv)\\s*=\\s*["']${k}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    "i"
  ).exec(html);
  if (a) return decodeEntities(a[1]).trim();
  const b = new RegExp(
    `<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property|http-equiv)\\s*=\\s*["']${k}["']`,
    "i"
  ).exec(html);
  return b ? decodeEntities(b[1]).trim() : null;
}

/** The `lang` attribute on `<html>`, lowercased, or null. */
export function htmlLang(html: string): string | null {
  const m = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);
  return m ? m[1].trim().toLowerCase() : null;
}

/** Text of h1–h3, entity-decoded, inner tags removed. */
export function headings(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = decodeEntities(m[2].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (t) out.push(t);
  }
  return out;
}

/** Visible body text, entity-decoded. */
export function decodedVisibleText(html: string): string {
  return decodeEntities(visibleText(html)).replace(/\s+/g, " ").trim();
}

/**
 * Lowercase, letters and digits only, single-spaced, padded with one space each
 * side — so `haystack.includes(" " + needle + " ")` is a word-boundary match
 * that treats `Leominster,` and `(Leominster)` alike and never matches
 * `Leominster` inside `Leominsterrotary`.
 */
export function normalizeForMatch(s: string): string {
  const flat = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return ` ${flat} `;
}

/** Word-boundary, case- and punctuation-insensitive containment. */
export function containsPhrase(normalizedHaystack: string, phrase: string): boolean {
  const n = normalizeForMatch(phrase);
  if (n.trim().length === 0) return false;
  return normalizedHaystack.includes(n);
}

/** Every href on the page. */
export function hrefs(html: string): string[] {
  return [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}

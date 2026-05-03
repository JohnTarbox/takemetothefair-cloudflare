/**
 * Shared utility helpers used by both the main app and the MCP server.
 *
 * All exports here are pure functions, no I/O, no side effects. The package
 * deliberately stays minimal — anything app-specific (UI helpers, query
 * builders, validation) lives elsewhere.
 */

import slugify from "slugify";

/**
 * Decode common HTML entities in user-supplied text.
 *
 * Used at the validation-schema boundary so dedup matching, slug generation,
 * and storage all see literal characters even when callers send entity-
 * encoded text (e.g. `&amp;` from agents posting form data). Without this,
 * an MCP tool posting "Earth Expo &amp; Convention Center" would not dedup
 * against the existing "Earth Expo & Convention Center" row.
 *
 * Single source of truth — the previous local copy at
 * src/lib/url-import/html-parser.ts was deleted in favour of this map. Maps
 * to proper Unicode characters (e.g. `&copy;` → `©`, not `(c)`) — accurate
 * for storage and dedup, fine for downstream AI processing.
 *
 * Skip for URL fields (URL-encoded `&` is meaningful in query strings),
 * email/phone/state codes, enum values, and FK ids.
 */
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  // Typographic
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&bull;": "•",
  "&middot;": "·",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  // Symbol
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
};

export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  let decoded = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.replace(new RegExp(entity, "g"), char);
  }
  // Numeric entities (decimal + hex). Covers everything not in the named map.
  decoded = decoded.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
  return decoded;
}

/**
 * Canonical slug generator, backed by the `slugify` library. Use for new
 * slugs everywhere — venue, vendor, promoter, blog post slugs.
 *
 * `strict: true` removes special characters; `lower: true` is self-explanatory;
 * `trim: true` strips leading/trailing whitespace. Handles Unicode correctly
 * (e.g. accented Latin characters fold to ASCII; non-Latin scripts get
 * transliterated where possible).
 */
export function createSlug(text: string): string {
  return slugify(text, {
    lower: true,
    strict: true,
    trim: true,
  });
}

/**
 * Legacy naive slug generator. Used by scrapers (`src/lib/scrapers/*.ts`)
 * to produce stable `sourceId` values from scraped event names.
 *
 * Kept distinct from the canonical `createSlug` because changing the
 * algorithm would change the sourceId for any event with non-ASCII
 * characters in its name, causing the next sync to re-import existing
 * events as "new" rows. The cost of unifying outweighs the benefit.
 *
 * Do NOT use this for new slug generation — use `createSlug`.
 */
export function createSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

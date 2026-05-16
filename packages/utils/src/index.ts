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
 * Strip stray tool-call envelope markup from free-text user fields.
 *
 * When an LLM constructs a tool-call payload, it occasionally hallucinates a
 * closing envelope tag inside an argument string. The first observed case
 * (Laconia Pumpkin Festival, 2026-05-05) had a description containing literal
 * `</description>\n</invoke>` text. We sanitize at the schema boundary so the
 * tag artifacts never reach storage, regardless of which agent harness is
 * used.
 *
 * Conservative whitelist: strips only the specific tag families known to leak
 * from agent harnesses (Anthropic `antml:*`, OpenAI/MCP `invoke`/`function_calls`/
 * `parameter`, plus stray `</description>` and `</function>`). A user writing
 * "she said <em>amazing</em>" or "1 < 2" passes through unchanged.
 *
 * Apply via `.transform(stripToolCallMarkup)` in Zod schemas, AFTER
 * `decodeHtmlEntities` so encoded variants (`&lt;/invoke&gt;`) decode first.
 */
const TOOL_CALL_TAG_PATTERNS: RegExp[] = [
  /<\/?antml:[a-z_]+(?:\s[^>]*)?>/gi,
  /<\/?function_calls\s*>/gi,
  /<\/?invoke(?:\s[^>]*)?>/gi,
  /<\/?parameter(?:\s[^>]*)?>/gi,
  /<\/?function(?:\s[^>]*)?>/gi,
  /<\/description\s*>/gi,
];

export function stripToolCallMarkup(text: string): string {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of TOOL_CALL_TAG_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  // Collapse the whitespace that often surrounds stripped tags (e.g. the
  // trailing `\n` after `</description>`) so we don't leave weird gaps.
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
}

/**
 * Composed sanitizer for free-text user input. Use at every Zod schema
 * boundary that accepts prose (names, descriptions, titles). Decodes HTML
 * entities first, then strips tool-call envelope artifacts. Both are
 * idempotent on clean input, so applying this everywhere is safe.
 */
export function sanitizeProse(text: string): string {
  return stripToolCallMarkup(decodeHtmlEntities(text));
}

/**
 * Branded slug type. A `Slug` is a `string` that has been through one of the
 * canonical slug generators (createSlug or createSlugFromName) — never a
 * raw user-supplied or hand-written string. The brand prevents accidental
 * mixing of "string-shaped values that happen to look slug-like" with
 * "actual normalized slugs," which silently caused duplicate venue rows
 * in production (issue #120).
 *
 * At the boundary (URL params, request bodies), use `unsafeSlug()` to assert
 * a string is already slug-shaped. This is intentionally an explicit cast —
 * the call site is the right place to think about whether the value really
 * came from a canonical generator.
 */
export type Slug = string & { readonly __brand: unique symbol };

/**
 * Boundary cast for strings that arrive in slug shape from outside the
 * type system (Next.js URL params, JSON request bodies, D1 SELECT results
 * pre-migration). Trust-but-name: by writing `unsafeSlug(x)` you're
 * declaring "I know x is a canonical slug." Searchable so audits can list
 * every assumption.
 */
export function unsafeSlug(s: string): Slug {
  return s as Slug;
}

/**
 * Append a suffix to an existing Slug while preserving the brand. Used by
 * collision-resolution loops that build `${slug}-${n}` or `${slug}-${city}`.
 * Hyphen and digits are valid slug characters, so the result is still a
 * canonical slug provided `slug` is and `segment` is slug-safe.
 */
export function appendSlugSegment(slug: Slug, segment: Slug | string | number): Slug {
  return `${slug}-${segment}` as Slug;
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
export function createSlug(text: string): Slug {
  return slugify(text, {
    lower: true,
    strict: true,
    trim: true,
  }) as Slug;
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
export function createSlugFromName(name: string): Slug {
  return (
    name
      .toLowerCase()
      // eslint-disable-next-line no-restricted-syntax -- canonical legacy implementation; this is the one place the regex chain is intentional.
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") as Slug
  );
}

// ---------------------------------------------------------------------------
// Money — single conversion-site convention
// ---------------------------------------------------------------------------
//
// All monetary columns are stored as INTEGER cents (post-migrations 0044 +
// 0048). These two helpers are the ONLY allowed conversion sites between
// dollars and cents; if you find yourself writing `something / 100` or
// `something * 100` outside them, you've reintroduced the precision-loss
// drift the migrations eliminated. See project_money_storage_convention
// in /home/wa1kli/.claude/projects/.../memory/.

/**
 * Convert dollars (form input or MCP free-text) to integer cents (storage).
 * Use at the API/MCP boundary when accepting price input from validation
 * schemas that still parse as dollars.
 *
 * Accepts the broader `unknown` shape so the same helper covers both:
 *   - typed callers that pass `number | null | undefined`, and
 *   - MCP/JSON callers that may pass numeric strings
 * Non-finite inputs (NaN, Infinity, non-numeric strings) → null.
 */
export function dollarsToCents(dollars: unknown): number | null {
  if (dollars == null) return null;
  const n = typeof dollars === "number" ? dollars : Number(dollars);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Format a price range stored as integer cents. Drops trailing `.00` for
 * whole-dollar amounts (e.g. "$25" not "$25.00"); renders cents when
 * present ("$10.50").
 *
 * UX contract:
 *   - Both null/undefined → "Price TBD" (caller has no data — distinct from
 *     "free", since silently displaying a paid event as "Free" is a worse
 *     failure mode than admitting we don't know).
 *   - {min:0, max:0} or {min:0, max:null} → "Free" (explicitly free).
 *   - {min:0, max:10} → "Up to $10" (free entry possible up to $10),
 *     not "$0 - $10".
 *
 * Separator is " - " (ASCII hyphen-with-spaces) for browser/email/JSON
 * compatibility — narrower than the typographic en-dash but renders
 * identically across every consumer of this library.
 */
// ---------------------------------------------------------------------------
// Completeness scoring (§10.2). Pure scorers shared between main app and MCP.
// Stateful recompute helpers (post-write DB UPDATEs) live in
// src/lib/completeness.ts because they take a Drizzle DB handle.
// ---------------------------------------------------------------------------

/**
 * §10.2 sitemap quality gate threshold. Entries with completeness < 40 are
 * excluded from /sitemap.xml.
 */
export const SITEMAP_MIN_COMPLETENESS = 40;

export type VendorScoreInput = {
  description: string | null;
  logoUrl: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  vendorType: string | null;
  products: string | null;
  claimed: boolean | null;
};

export type EventScoreInput = {
  description: string | null;
  startDate: Date | null;
  endDate: Date | null;
  venueId: string | null;
  isStatewide: boolean | null;
  categories: string | null;
  imageUrl: string | null;
  ticketPriceMinCents: number | null;
  ticketPriceMaxCents: number | null;
};

function scoreNonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

function scoreNonEmptyJsonArray(s: string | null | undefined): boolean {
  if (!scoreNonEmpty(s)) return false;
  if (s === "[]") return false;
  try {
    const parsed = JSON.parse(s as string);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Vendor completeness rubric (sums to 100):
 *   description 30 | logo 15 | phone-or-email 10 | website 10
 *   vendor_type 15 | products 10 | claimed 10
 */
export function computeVendorCompletenessScore(v: VendorScoreInput): number {
  let score = 0;
  if (scoreNonEmpty(v.description)) score += 30;
  if (scoreNonEmpty(v.logoUrl)) score += 15;
  if (scoreNonEmpty(v.contactPhone) || scoreNonEmpty(v.contactEmail)) score += 10;
  if (scoreNonEmpty(v.website)) score += 10;
  if (scoreNonEmpty(v.vendorType)) score += 15;
  if (scoreNonEmptyJsonArray(v.products)) score += 10;
  if (v.claimed === true) score += 10;
  return score;
}

/**
 * Event completeness rubric (sums to 100):
 *   description 30 | start+end 20 | venue-or-statewide 15
 *   categories 15 | image 10 | price min-or-max 10
 */
export function computeEventCompletenessScore(e: EventScoreInput): number {
  let score = 0;
  if (scoreNonEmpty(e.description)) score += 30;
  if (e.startDate && e.endDate) score += 20;
  if (e.venueId !== null || e.isStatewide === true) score += 15;
  if (scoreNonEmptyJsonArray(e.categories)) score += 15;
  if (scoreNonEmpty(e.imageUrl)) score += 10;
  if (e.ticketPriceMinCents !== null || e.ticketPriceMaxCents !== null) score += 10;
  return score;
}

export * from "./duplicates";

export function formatPrice(minCents?: number | null, maxCents?: number | null): string {
  const renderOne = (cents: number) => {
    const dollars = cents / 100;
    return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
  };
  // Distinguish "no data" from "explicitly free" — `!0` is truthy, so the
  // existing falsy-collapse below would otherwise render unset prices as "Free".
  if (minCents == null && maxCents == null) return "Price TBD";
  const min = !minCents ? null : minCents;
  const max = !maxCents ? null : maxCents;
  if (min == null && max == null) return "Free";
  if (min === max || max == null) return renderOne(min!);
  if (min == null) return `Up to ${renderOne(max)}`;
  return `${renderOne(min)} - ${renderOne(max)}`;
}

// Pre-ingest date-quality gates — pure-function helpers shared by main app
// ingest paths and the MCP server's vendor.suggest_event tool.
export * from "./event-date-gates";

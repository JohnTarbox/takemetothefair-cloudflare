import { decodeHtmlEntities, formatDateRange } from "@/lib/utils";
import { parseJsonArray } from "@/types";

const META_DESCRIPTION_MAX = 160;
const META_DESCRIPTION_MIN_USEFUL = 50;
const TITLE_SOFT_MAX = 60; // Google's mobile truncation threshold

// New-England-only deployment per CLAUDE.md. Map state codes to full names so
// we can detect "Vermont Maple Open House" already containing "Vermont" and
// skip the redundant `· Vermont` suffix in the title.
const NE_STATE_NAMES: Record<string, string> = {
  CT: "Connecticut",
  ME: "Maine",
  MA: "Massachusetts",
  NH: "New Hampshire",
  RI: "Rhode Island",
  VT: "Vermont",
};

/**
 * Truncate to maxLength while respecting word/sentence boundaries when the
 * break wouldn't lose more than 40% of the budget. Prefers sentence boundaries
 * (`. `, `! `, `? `) when one is available within the safe region; otherwise
 * falls back to a word boundary.
 */
function truncateAtWord(text: string, maxLength: number, preferSentence = false): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const safeFloor = maxLength * 0.6;
  if (preferSentence) {
    // Find the latest sentence end within the safe region.
    const sentenceMatch = truncated.match(/^(.*[.!?])(?:\s+\S*)?$/s);
    if (sentenceMatch && sentenceMatch[1].length > safeFloor) {
      return sentenceMatch[1];
    }
  }
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > safeFloor ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Truncate at the latest clause boundary within maxLength. Clause boundary =
 * `.`, `!`, `?`, `;`, `—` (em-dash), `–` (en-dash). Accepts cuts as short as
 * 50% of the budget — sentence-clean is more important than maxing out chars.
 * After cutting, strips trailing `;`/`—`/`–` (these suggest continuation) and
 * any dangling function word. Falls back to word boundary when no clause break
 * exists in the budget (round-2 backlog item 2, 2026-05-11).
 */
function truncateAtClause(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const safeFloor = maxLength * 0.5;
  const clauseMatch = truncated.match(/^(.*[.!?;—–])(?:\s+\S*)?$/s);
  if (clauseMatch && clauseMatch[1].length > safeFloor) {
    const stripped = clauseMatch[1].replace(/[;—–]\s*$/, "").trimEnd();
    return trimTrailingFunctionWord(stripped);
  }
  const lastSpace = truncated.lastIndexOf(" ");
  const fallback = lastSpace > safeFloor ? truncated.slice(0, lastSpace) : truncated;
  return trimTrailingFunctionWord(fallback);
}

/**
 * Trim trailing function words (conjunctions, articles, prepositions) from
 * a word-truncated string. The truncator stops at word boundaries, which
 * sometimes leaves a hanging "and" / "for" / "the" / "of" before the suffix
 * appends — reading awkwardly. Strip them along with any trailing comma.
 *
 * Exported for testing.
 */
export function trimTrailingFunctionWord(text: string): string {
  // Match (1+ trim cycles): optional comma, whitespace, function word, end.
  // Repeated to handle e.g. "...crafts, and " → "...crafts" (strip "and" then ",").
  const FUNCTION_WORDS =
    /[\s,;:—-]+(?:and|or|but|nor|for|the|a|an|of|to|in|on|at|by|with|from|into|onto|upon)$/i;
  let prev = text.trimEnd();
  let next = prev.replace(FUNCTION_WORDS, "");
  while (next !== prev) {
    prev = next.trimEnd().replace(/[,;:]+$/, "");
    next = prev.replace(FUNCTION_WORDS, "");
  }
  return next.trimEnd().replace(/[,;:]+$/, "");
}

/**
 * Short date format for meta descriptions where every char counts.
 * Single day: "Mar 7, 2026"
 * Multi-day same year/month: "Mar 7-8, 2026"
 * Multi-day same year, different month: "Sep 9 - Oct 2, 2026"
 * Multi-year: "Dec 30, 2026 - Jan 2, 2027"
 *
 * Built on top of formatDateRange to reuse its UTC-anchored "TBD" handling
 * and same-day collapse, then post-processes for the compact form.
 */
function formatDateRangeForMeta(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined
): string {
  const range = formatDateRange(start, end);
  if (range === "TBD") return "";
  // formatDateRange returns "Sat, Mar 7, 2026" or "Sat, Mar 7, 2026 - Sun, Mar 8, 2026"
  // — strip the leading weekday and (when same month/year) collapse to "Mar 7-8, 2026".
  const stripWeekday = (s: string) => s.replace(/^[A-Za-z]{3,},\s+/, "");
  const parts = range.split(" - ");
  if (parts.length === 1) return stripWeekday(parts[0]);
  const left = stripWeekday(parts[0]);
  const right = stripWeekday(parts[1]);
  // Same year? Compare trailing year tokens.
  const yLeft = left.match(/(\d{4})$/)?.[1];
  const yRight = right.match(/(\d{4})$/)?.[1];
  if (!yLeft || !yRight || yLeft !== yRight) return `${left} - ${right}`;
  // Same year. Same month?
  const mLeft = left.match(/^([A-Za-z]+)\s+(\d+)/);
  const mRight = right.match(/^([A-Za-z]+)\s+(\d+)/);
  if (mLeft && mRight && mLeft[1] === mRight[1]) {
    return `${mLeft[1]} ${mLeft[2]}-${mRight[2]}, ${yLeft}`;
  }
  // Same year, different month. Drop year from left side: "Sep 9 - Oct 2, 2026".
  const leftNoYear = left.replace(/,?\s*\d{4}$/, "");
  return `${leftNoYear} - ${right}`;
}

/**
 * Quality gate for using a DB description as the meta-description lead.
 * Rejects too-short, too-long, leading import-source garbage, and excessive
 * caps. When this returns false, the caller falls back to the structured
 * `date · venue · category` form.
 */
export function isCleanDbDescription(desc: string | null | undefined): boolean {
  if (!desc) return false;
  const trimmed = desc.trim();
  if (trimmed.length < 30 || trimmed.length > 5000) return false;
  const garbagePrefixes = [
    /^Contact:/i,
    /^Imported from /i,
    /^\[Name\]/i,
    /^TBD$/i,
    /^See website/i,
    /^N\/A$/i,
  ];
  if (garbagePrefixes.some((re) => re.test(trimmed))) return false;
  const letters = trimmed.match(/[A-Za-z]/g) ?? [];
  const upper = trimmed.match(/[A-Z]/g) ?? [];
  if (letters.length > 0 && upper.length / letters.length > 0.4) return false;
  return true;
}

/**
 * Strip a leading sentence from `desc` that's redundant with the date/name
 * suffix the meta builder appends. Two patterns covered:
 *   - "X will be held on March 7, 2026."
 *   - "Portland World Oddities Expo will be held on March 21-22, 2026."
 * If the first sentence contains the event name AND a date-shaped fragment,
 * drop it. Returns the original string unchanged when no match.
 */
export function stripRedundantLeadSentence(desc: string, eventName: string): string {
  const trimmed = desc.trim();
  // Find first sentence end (., !, ?). If the first sentence is too long
  // (>200 chars), don't strip — likely not a formulaic intro.
  const match = trimmed.match(/^([^.!?]{1,200}[.!?])\s+(\S.*)$/s);
  if (!match) return trimmed;
  const firstSentence = match[1];
  const rest = match[2];
  const nameLower = eventName.toLowerCase();
  const sentenceLower = firstSentence.toLowerCase();
  const containsName =
    sentenceLower.includes(nameLower) ||
    // Tolerate the event name with leading "20XX " stripped (common slug noise)
    (eventName.match(/^\d{4}\s+/) && sentenceLower.includes(nameLower.replace(/^\d{4}\s+/, "")));
  // Date pattern: month name + day (with optional ordinal suffix and optional
  // range) + year. Standalone ordinals like "45th" or "11th" are NOT date
  // indicators on their own (they're often event-edition labels).
  const datePattern =
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d+(?:st|nd|rd|th)?(?:[-–]\d+(?:st|nd|rd|th)?)?,?\s*\d{4}\b/i;
  const containsDate = datePattern.test(firstSentence);
  if (containsName && containsDate) return rest;
  return trimmed;
}

/**
 * Build the event page title. Format: `Name · City, ST` with smart skips
 * when the event name already contains the city or state name. Drops the
 * "| Meet Me at the Fair" brand suffix to recover ~22 chars of mobile-title
 * budget — Google strips long brand suffixes anyway and meta-description is
 * a stronger brand-recall surface.
 *
 * Statewide events get `· Statewide ${StateName}` instead of `· City, ST`.
 */
export function buildEventTitle(event: {
  name: string;
  isStatewide?: boolean | null;
  stateCode?: string | null;
  venue?: { city?: string | null; state?: string | null } | null;
}): string {
  const name = decodeHtmlEntities(event.name);
  const nameLower = name.toLowerCase();

  // Statewide path
  if (event.isStatewide) {
    const stateName = event.stateCode ? NE_STATE_NAMES[event.stateCode.toUpperCase()] : null;
    if (stateName && !nameLower.includes(stateName.toLowerCase())) {
      return `${name} · Statewide ${stateName}`;
    }
    return name;
  }

  const city = event.venue?.city?.trim() || "";
  const state = event.venue?.state?.trim() || event.stateCode?.trim() || "";
  const stateName = state ? NE_STATE_NAMES[state.toUpperCase()] : null;

  const nameHasCity = !!city && nameLower.includes(city.toLowerCase());
  const nameHasState =
    !!state &&
    (nameLower.includes(state.toLowerCase()) ||
      !!(stateName && nameLower.includes(stateName.toLowerCase())));

  // Suffix decision matrix:
  // - city in name, state in name → no suffix (both redundant)
  // - city in name, state not in name → "· ST"
  // - city not in name, state in name → "· City"
  // - neither in name, both available → "· City, ST"
  // - neither in name, only state → "· ST"
  // - neither in name, only city → "· City"
  if (nameHasCity && nameHasState) return name;
  if (nameHasCity && state && !nameHasState) return `${name} · ${state}`;
  if (!nameHasCity && city && nameHasState) return `${name} · ${city}`;
  if (!nameHasCity && city && state) return `${name} · ${city}, ${state}`;
  if (!nameHasState && state) return `${name} · ${state}`;
  if (!nameHasCity && city) return `${name} · ${city}`;
  return name;
}

/**
 * Build the event meta description. Algorithm (round-2 backlog 2026-05-11):
 *   1. If event has a clean DB description (per isCleanDbDescription), strip
 *      any redundant lead sentence; return verbatim if it fits in 160 chars,
 *      otherwise truncate at clause boundary.
 *   2. If gate fails, use a natural-language fallback form:
 *        `${name} happening ${date} at ${venue} in ${city}, ${state}. ${cat}.`
 *      with each piece skipped gracefully when missing.
 *
 * No appended `· DateRange · Venue, City State` suffix — the title and the
 * rendered card already cover that, and the suffix was forcing mid-word
 * truncation of the lead text.
 */
export function buildEventMetaDescription(event: {
  name: string;
  description?: string | null;
  categories?: string | null;
  venue?: { name: string; city?: string | null; state?: string | null } | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}): string {
  const name = decodeHtmlEntities(event.name);
  const dateStr = formatDateRangeForMeta(event.startDate, event.endDate);
  const venueName = event.venue?.name ? decodeHtmlEntities(event.venue.name) : "";
  const city = event.venue?.city?.trim() || "";
  const state = event.venue?.state?.trim() || "";
  const desc = decodeHtmlEntities(event.description?.trim() || "");

  // Path 1: clean DB description leads. No suffix — render full description
  // verbatim when it fits, otherwise cut at clause boundary.
  if (isCleanDbDescription(desc)) {
    const cleaned = stripRedundantLeadSentence(desc, name);
    if (cleaned.length <= META_DESCRIPTION_MAX) return cleaned;
    return truncateAtClause(cleaned, META_DESCRIPTION_MAX);
  }

  // Path 2: natural-language fallback when DB description fails the gate.
  const categories = parseJsonArray(event.categories);
  const primaryCategory = categories[0];
  const pieces: string[] = [name];
  if (dateStr) pieces.push(`happening ${dateStr}`);
  if (venueName) {
    pieces.push(`at ${venueName}`);
    if (city && state) pieces.push(`in ${city}, ${state}`);
  } else if (city && state) {
    pieces.push(`in ${city}, ${state}`);
  }
  let result = pieces.join(" ") + ".";
  if (primaryCategory) result += ` ${primaryCategory}.`;
  if (result.length <= META_DESCRIPTION_MAX) return result;
  return truncateAtClause(result, META_DESCRIPTION_MAX);
}

export function buildVenueMetaDescription(venue: {
  name: string;
  description?: string | null;
  city?: string | null;
  state?: string | null;
  amenities?: string | null;
  capacity?: number | null;
}): string {
  const name = decodeHtmlEntities(venue.name);
  const locPhrase = venue.city && venue.state ? ` in ${venue.city}, ${venue.state}` : "";

  const desc = decodeHtmlEntities(venue.description?.trim() || "");
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const prefix = `${name}${locPhrase}. `;
    const remaining = META_DESCRIPTION_MAX - prefix.length;
    if (remaining > 20) {
      return prefix + truncateAtClause(desc, remaining);
    }
  }

  // Fallback when no usable DB description: 73% of venues hit this path
  // (round-2 backlog item 3, 2026-05-11). Plain location-first form, no
  // amenities pull — keeps the meta clean and consistent across the catalog.
  return truncateAtWord(
    `${name} is an event venue${locPhrase}. View upcoming fairs, festivals, and shows on Meet Me at the Fair.`,
    META_DESCRIPTION_MAX
  );
}

export function buildVendorMetaDescription(vendor: {
  businessName: string;
  description?: string | null;
  vendorType?: string | null;
  products?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const businessName = decodeHtmlEntities(vendor.businessName);
  const vendorType = vendor.vendorType ? decodeHtmlEntities(vendor.vendorType) : "";
  const base = vendorType ? `${businessName} — ${vendorType}` : businessName;

  const desc = decodeHtmlEntities(vendor.description?.trim() || "");
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const prefix = `${base}. `;
    const remaining = META_DESCRIPTION_MAX - prefix.length;
    if (remaining > 20) {
      return prefix + truncateAtClause(desc, remaining);
    }
  }

  // Fallback when no usable DB description: 75% of vendors hit this path
  // (round-2 backlog item 3, 2026-05-11). ~half of vendors lack city+state,
  // so the location phrase is optional.
  const typePhrase = vendorType ? `${businessName} — ${vendorType} vendor` : businessName;
  const locationPhrase =
    vendor.city && vendor.state ? ` based in ${vendor.city}, ${vendor.state}` : "";
  return truncateAtWord(
    `${typePhrase}${locationPhrase}. View upcoming events on Meet Me at the Fair.`,
    META_DESCRIPTION_MAX
  );
}

// Suppress unused-import warnings during typecheck — TITLE_SOFT_MAX is
// referenced in tests that audit title length but not in the runtime path
// (buildEventTitle has no truncation; long names stay long, Google handles).
export { TITLE_SOFT_MAX };

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
 * Build the event meta description. Algorithm:
 *   1. Compute a date+location suffix (each piece conditionally included).
 *   2. If event has a clean DB description (per isCleanDbDescription), strip
 *      any redundant lead sentence, lead with the cleaned description,
 *      truncate to fit within budget minus suffix length, append suffix.
 *   3. If gate fails, use a structured fallback form:
 *        `${date} · ${venue}, ${city} ${state} · ${category}. Browse vendors,
 *         schedule, directions, and how to attend.`
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

  // Suffix builder — included pieces conditional on (a) value present and
  // (b) value not already mentioned in the lead text passed in.
  function buildSuffix(leadText: string): string {
    const leadLower = leadText.toLowerCase();
    const pieces: string[] = [];
    if (dateStr && !leadLower.includes(dateStr.toLowerCase())) {
      pieces.push(dateStr);
    }
    if (venueName && !leadLower.includes(venueName.toLowerCase())) {
      const loc = city && state ? `${venueName}, ${city} ${state}` : venueName;
      pieces.push(loc);
    } else if (!venueName && city && state && !leadLower.includes(city.toLowerCase())) {
      pieces.push(`${city}, ${state}`);
    }
    if (pieces.length === 0) return "";
    return ` ${pieces.join(" · ")}.`;
  }

  // Path 1: clean DB description leads.
  if (isCleanDbDescription(desc)) {
    const cleaned = stripRedundantLeadSentence(desc, name);
    // Reserve room for the suffix. Compute suffix against placeholder lead
    // first to estimate length, then re-compute against actual lead.
    const placeholderSuffix = buildSuffix("");
    const leadBudget = META_DESCRIPTION_MAX - placeholderSuffix.length;
    const truncatedLead = truncateAtWord(cleaned, leadBudget, /* preferSentence */ true);
    const lead = trimTrailingFunctionWord(truncatedLead);
    const suffix = buildSuffix(lead);
    return (lead + suffix).slice(0, META_DESCRIPTION_MAX);
  }

  // Path 2: structured fallback when DB description fails the gate.
  const categories = parseJsonArray(event.categories);
  const primaryCategory = categories[0];
  const fallbackPieces: string[] = [];
  if (dateStr) fallbackPieces.push(dateStr);
  if (venueName) {
    const loc = city && state ? `${venueName}, ${city} ${state}` : venueName;
    fallbackPieces.push(loc);
  } else if (city && state) {
    fallbackPieces.push(`${city}, ${state}`);
  }
  if (primaryCategory) fallbackPieces.push(primaryCategory);

  const head = fallbackPieces.length > 0 ? `${fallbackPieces.join(" · ")}.` : `${name}.`;
  const tail = " Browse vendors, schedule, directions, and how to attend.";
  if (head.length + tail.length <= META_DESCRIPTION_MAX) return head + tail;
  return truncateAtWord(head, META_DESCRIPTION_MAX, /* preferSentence */ true);
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
  const location = venue.city && venue.state ? ` in ${venue.city}, ${venue.state}` : "";
  const base = `${name}${location}`;

  const desc = decodeHtmlEntities(venue.description?.trim() || "");
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      return truncateAtWord(`${base}. ${truncateAtWord(desc, remaining)}`, META_DESCRIPTION_MAX);
    }
  }

  // Structured fallback: prefer top amenities, otherwise generic event hint.
  const amenities = parseJsonArray(venue.amenities);
  if (amenities.length > 0) {
    const featured = amenities.slice(0, 3).join(", ");
    return truncateAtWord(
      `${base}. Featuring ${featured}. Browse upcoming fairs, festivals, and events.`,
      META_DESCRIPTION_MAX
    );
  }

  return truncateAtWord(
    `${base}. Hosting fairs, festivals, and events. View upcoming dates and vendor lineups.`,
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
  const base = vendor.vendorType ? `${businessName} — ${vendor.vendorType}` : businessName;

  const desc = decodeHtmlEntities(vendor.description?.trim() || "");
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const remaining = 155 - base.length - 2;
    if (remaining > 20) {
      return truncateAtWord(`${base}. ${truncateAtWord(desc, remaining)}`, META_DESCRIPTION_MAX);
    }
  }

  // Structured fallback: top products + location so each vendor's meta
  // description differs from the next, even with no DB description.
  const products = parseJsonArray(vendor.products);
  const productPhrase = products.length > 0 ? `. ${products.slice(0, 3).join(", ")}` : "";
  const locationPhrase =
    vendor.city && vendor.state ? `, based in ${vendor.city}, ${vendor.state}` : "";

  if (productPhrase || locationPhrase) {
    return truncateAtWord(
      `${base}${productPhrase}${locationPhrase}. Find upcoming events on Meet Me at the Fair.`,
      META_DESCRIPTION_MAX
    );
  }

  return truncateAtWord(
    `${base}. Find upcoming events and learn more on Meet Me at the Fair.`,
    META_DESCRIPTION_MAX
  );
}

// Suppress unused-import warnings during typecheck — TITLE_SOFT_MAX is
// referenced in tests that audit title length but not in the runtime path
// (buildEventTitle has no truncation; long names stay long, Google handles).
export { TITLE_SOFT_MAX };

import { decodeHtmlEntities, formatDateRange } from "@/lib/utils";
import { parseJsonArray } from "@/types";
import { displayVenueName } from "@/lib/venue-display";
import { truncateAtBoundary, trimTrailingFunctionWord } from "@/lib/seo/truncate-meta";
import {
  composeEventFallback,
  composeVendorFallback,
  composeVenueFallback,
  composePromoterFallback,
} from "@/lib/seo/compose-meta";

// Re-export for back-compat: trimTrailingFunctionWord moved to the shared
// truncate-meta module (used by truncateAtBoundary); existing imports from
// "@/lib/seo-utils" keep working.
export { trimTrailingFunctionWord };

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
  startDate?: Date | string | null;
  venue?: { city?: string | null; state?: string | null } | null;
}): string {
  // OPE-266 — inject the event YEAR into the title. The top zero-click SERP
  // queries are all "{event} {year}" / "{event} {year} dates" (Marshfield Fair
  // 2026, Barnstable Fair 2026, …): the page ranks 4–10 but the title showed no
  // year, so it failed the searcher's intent match. Additive + backward compat:
  // no startDate → no year (existing callers/tests unchanged); skip when the
  // name already carries the year (e.g. "…Weekend 2027").
  const rawName = decodeHtmlEntities(event.name);
  const nameLower = rawName.toLowerCase();
  const year = event.startDate ? new Date(event.startDate).getUTCFullYear() : null;
  const name =
    year && Number.isFinite(year) && !nameLower.includes(String(year))
      ? `${rawName} ${year}`
      : rawName;

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
  const city = event.venue?.city?.trim() || "";
  const state = event.venue?.state?.trim() || "";
  const desc = decodeHtmlEntities(event.description?.trim() || "");

  // Path 1: clean DB description leads. No suffix — render full description
  // verbatim when it fits (≤160), otherwise boundary-truncate with an ellipsis.
  if (isCleanDbDescription(desc)) {
    const cleaned = stripRedundantLeadSentence(desc, name);
    return truncateAtBoundary(cleaned, META_DESCRIPTION_MAX);
  }

  // Path 2 (OPE-42): richer entity-specific composed fallback. Leads with the
  // event name + category + location + date(s), so it is neither too short nor
  // duplicate across the catalog (the Bing complaint). venueName is
  // intentionally not used here — the composed template keys off city/state.
  const categories = parseJsonArray(event.categories);
  const primaryCategory = categories[0];
  return composeEventFallback({
    name,
    category: primaryCategory,
    city,
    state,
    dates: dateStr,
  });
}

export function buildVenueMetaDescription(venue: {
  name: string;
  description?: string | null;
  // Cohort 8 follow-up (2026-06-01) — address is forwarded to the
  // display-name fallback below so meta descriptions on street-address-
  // named venues read "Event venue in {City}, {State}. …" instead of
  // "18 Spring Street. …". Optional so existing callers compile.
  address?: string | null;
  city?: string | null;
  state?: string | null;
  amenities?: string | null;
  capacity?: number | null;
}): string {
  // Cohort 8 follow-up (2026-06-01) — use displayVenueName so the
  // meta description's leading clause reads "Event venue in
  // {City}, {State}. …" for street-address-named rows.
  const name = decodeHtmlEntities(displayVenueName(venue));
  const locPhrase = venue.city && venue.state ? ` in ${venue.city}, ${venue.state}` : "";

  const desc = decodeHtmlEntities(venue.description?.trim() || "");
  if (desc.length >= META_DESCRIPTION_MIN_USEFUL) {
    const prefix = `${name}${locPhrase}. `;
    const remaining = META_DESCRIPTION_MAX - prefix.length;
    if (remaining > 20) {
      return prefix + truncateAtBoundary(desc, remaining);
    }
  }

  // Fallback when no usable DB description: 73% of venues hit this path
  // (round-2 backlog item 3, 2026-05-11). OPE-42 — richer composed template
  // (schedule + vendor info) so it isn't too short / duplicate across venues.
  return composeVenueFallback({ name, city: venue.city, state: venue.state });
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
      return prefix + truncateAtBoundary(desc, remaining);
    }
  }

  // Fallback when no usable DB description: 75% of vendors hit this path
  // (round-2 backlog item 3, 2026-05-11). OPE-42 — richer composed template so
  // the meta isn't too short / duplicate; city/state optional (~half lack it).
  return composeVendorFallback({
    businessName: vendor.businessName,
    vendorType: vendor.vendorType,
    city: vendor.city,
    state: vendor.state,
  });
}

/**
 * Build the promoter meta description (OPE-42). Previously the promoter page
 * inlined `promoter.description ?? <thin location/count sentence>` with no
 * quality gate and no truncation — the fallback was near-duplicate across
 * promoters. Now:
 *   1. If the promoter's own description passes the quality gate, lead with it,
 *      boundary-truncated with an ellipsis when long.
 *   2. Otherwise compose an entity-specific fallback from name + location.
 */
export function buildPromoterMetaDescription(promoter: {
  companyName: string;
  description?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  const desc = decodeHtmlEntities(promoter.description?.trim() || "");
  if (isCleanDbDescription(desc)) {
    return truncateAtBoundary(desc, META_DESCRIPTION_MAX);
  }
  return composePromoterFallback({
    name: promoter.companyName,
    city: promoter.city,
    state: promoter.state,
  });
}

// State index pages target high-intent generic queries like "fairs in
// massachusetts". GSC was showing position-15 with the generic static title
// "Fairs & Festivals in {State} | Meet Me at the Fair". The dynamic title +
// meta below interpolate the state name, year, and a live (rounded) event
// count for numeric specificity.

/** Round down to nearest 10 for stable inventory counts in meta descriptions.
 *  Avoids "187+" jittering with every ingest. */
export function roundDownToTen(n: number): number {
  if (n <= 0) return 0;
  return Math.floor(n / 10) * 10;
}

export function buildStateTitle(
  stateName: string,
  year: number = new Date().getFullYear()
): string {
  // Per analyst's 2026-05-16 SEO recommendation: lead with state + intent
  // categories, end with brand. Drives ranking on "fairs in {state} {year}"
  // queries that ranked page-2 with the prior title (e.g. "fairs in
  // massachusetts 2026" at position 15.4 in GSC).
  return `${stateName} Fairs & Festivals ${year} — Find Craft Fairs, Home Shows, Festivals · MMATF`;
}

export function buildStateMetaDescription(
  stateName: string,
  eventCount: number,
  // stateAdjective retained for callsite-compat; the new template uses
  // stateName directly. Will go away once all callers drop the arg.
  _stateAdjective: string,
  year: number = new Date().getFullYear()
): string {
  const rounded = roundDownToTen(eventCount);
  // When count is below 10, drop the "{N}+" prefix to avoid "0+ upcoming
  // Bay State fairs" — a rare path (state has no upcoming events) but the
  // meta shouldn't lie. Fall back to plain phrasing.
  const countPhrase =
    rounded > 0
      ? `${rounded}+ upcoming ${stateName} fairs, festivals, craft shows, and home shows for ${year}`
      : `Upcoming ${stateName} fairs, festivals, craft shows, and home shows for ${year}`;
  return `${countPhrase}. Browse events by month, category, or venue. Updated daily.`;
}

// Suppress unused-import warnings during typecheck — TITLE_SOFT_MAX is
// referenced in tests that audit title length but not in the runtime path
// (buildEventTitle has no truncation; long names stay long, Google handles).
export { TITLE_SOFT_MAX };

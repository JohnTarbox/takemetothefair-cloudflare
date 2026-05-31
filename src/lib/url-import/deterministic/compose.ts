/**
 * Composer for the three deterministic pre-extractors. Called from the
 * extract endpoint as a salvage path when AI extraction returns zero events
 * from a successfully-fetched page (K7 Tier 1, analyst 2026-05-31).
 *
 * Strategy:
 *   1. Run name lookup (OG → h1 → h2 → URL slug) and date-range regex
 *      against the cleaned page text in parallel.
 *   2. Scan for add-to-calendar links; if any parse to a concrete date
 *      range, that wins over the regex date (calendar URLs are structured
 *      data; regex is inference).
 *   3. If we have a name AND (a date range OR a venue address), return a
 *      synthesized event with `extractionMethod: 'thin'` and low field
 *      confidence so the workflow knows to flag the inbound row for human
 *      review.
 *
 * The "name + (date OR venue)" gate is intentional: we want to salvage
 * something the admin can confirm in 30 seconds, not synthesize a row from
 * just a heading. If the gate fails, return null — the workflow falls
 * through to the existing body-fallback (extract from email body) or hard-
 * fail path.
 *
 * `extractionMethod: 'thin'` lights up the inbound-emails flagged_for_review
 * column in the workflow's mark-done step, so /admin/inbound-emails has a
 * queue to triage. Tracked separately from 'json-ld' / 'ai' / 'free-text'
 * because thin extractions need different operator handling.
 */

import type { ExtractedEvent, ExtractedEventData, PageMetadata } from "../types";
import { findCalendarLinks, parseCalendarLink } from "./calendar-link";
import { findDateRange } from "./date-regex";
import { findEventName } from "./og-name";

export interface DeterministicComposeResult {
  events: ExtractedEvent[];
  confidence: Record<string, Record<string, "high" | "medium" | "low">>;
}

/**
 * Try every deterministic signal against the fetched HTML + metadata +
 * cleaned text. Returns a single-event array when the name+date OR
 * name+venue gate is met; empty array otherwise.
 *
 * `cleanedText` is the same text body the AI extractor receives — passed
 * through `extractTextFromHtml` upstream. Kept as a separate arg so the
 * extract endpoint can avoid re-parsing.
 */
export function composeDeterministicExtract(
  rawHtml: string,
  cleanedText: string,
  metadata: PageMetadata | undefined,
  url: string | undefined
): DeterministicComposeResult {
  const name = findEventName(rawHtml, metadata, url);

  // Calendar-link extraction wins on dates when available — these are
  // structured data, not inference. Merge into accumulator so other fields
  // (location, name from the calendar URL) survive.
  let calendarFields: Partial<ExtractedEventData> | null = null;
  for (const href of findCalendarLinks(rawHtml)) {
    const parsed = parseCalendarLink(href);
    if (parsed) {
      calendarFields = parsed;
      break; // First valid calendar link wins; pages rarely emit conflicting ones.
    }
  }

  // Date-regex over the cleaned text, used only when the calendar link
  // didn't supply dates.
  const regexDates = calendarFields?.startDate ? null : findDateRange(cleanedText);

  // Gate: need name AND (date OR venue). Anything less is too thin to
  // synthesize — better to fall through to the body-fallback than to ship
  // a half-built PENDING row.
  const startDate = calendarFields?.startDate ?? regexDates?.startDate ?? null;
  const endDate = calendarFields?.endDate ?? regexDates?.endDate ?? startDate;
  const venueAddress = calendarFields?.venueAddress ?? null;

  const effectiveName = name ?? calendarFields?.name ?? null;
  const hasDate = !!startDate;
  const hasVenue = !!venueAddress;
  if (!effectiveName || (!hasDate && !hasVenue)) {
    return { events: [], confidence: {} };
  }

  const extractId = `thin-${Date.now()}`;
  const event: ExtractedEvent = {
    _extractId: extractId,
    name: effectiveName,
    description: calendarFields?.description ?? null,
    startDate,
    endDate,
    startTime: calendarFields?.startTime ?? null,
    endTime: calendarFields?.endTime ?? null,
    hoursVaryByDay: false,
    hoursNotes: null,
    specificDates: null,
    venueName: null,
    venueAddress,
    venueCity: calendarFields?.venueCity ?? null,
    venueState: calendarFields?.venueState ?? null,
    isStatewide: false,
    stateCode: null,
    ticketUrl: null,
    ticketPriceMin: null,
    ticketPriceMax: null,
    imageUrl: metadata?.ogImage ?? null,
    categories: null,
    vendorFeeMin: null,
    vendorFeeMax: null,
    vendorFeeNotes: null,
    indoorOutdoor: null,
    estimatedAttendance: null,
    applicationUrl: null,
    walkInsAllowed: null,
  };

  // Confidence per field. Calendar-link-sourced fields are high (structured
  // data). Regex-derived dates are medium (we know it's a date, but recall
  // is imperfect). Name is medium (header text usually right but can be
  // chrome). Everything else is low — admin must confirm.
  const confidence: Record<string, "high" | "medium" | "low"> = {
    name: "medium",
    startDate: calendarFields?.startDate ? "high" : regexDates?.startDate ? "medium" : "low",
    endDate: calendarFields?.endDate ? "high" : regexDates?.endDate ? "medium" : "low",
    venueAddress: calendarFields?.venueAddress ? "high" : "low",
    venueCity: calendarFields?.venueCity ? "high" : "low",
    venueState: calendarFields?.venueState ? "high" : "low",
  };
  // Every other field gets low. Iterating the event object keeps this in
  // lockstep with type changes.
  for (const key of Object.keys(event)) {
    if (key.startsWith("_")) continue;
    if (!(key in confidence)) confidence[key] = "low";
  }

  return {
    events: [event],
    confidence: { [extractId]: confidence },
  };
}

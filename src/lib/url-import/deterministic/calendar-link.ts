/**
 * Deterministic extractor: parse Google Calendar / Outlook "Add to calendar"
 * links into event fields. Most WordPress event-calendar plugins (The Events
 * Calendar / Modern Tribe, Event Espresso, EventOn) emit one of these on
 * every event page — the event's own date + title + location encoded in
 * the calendar URL's query string. Zero-AI, exact-precision extraction
 * when present.
 *
 * Surfaced by the Carolyn moose-lottery submission (inbound fe65fb77,
 * 2026-05-31): the AI returned zero events from me2026mooseloto.com but
 * the page's add-to-calendar widget would have given us name + date range
 * with no inference required. Tier 1 of K7 — biggest reliability gain per
 * hour because these URLs are unambiguous structured data.
 *
 * Supported formats:
 *   1. Google Calendar template:
 *      https://calendar.google.com/calendar/render?action=TEMPLATE
 *        &text=<title>
 *        &dates=YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ        (with time + UTC)
 *        &dates=YYYYMMDD/YYYYMMDD                         (all-day)
 *        &location=<address>
 *        &details=<description>
 *   2. Outlook Calendar deeplink:
 *      https://outlook.live.com/calendar/0/deeplink/compose?
 *        path=/calendar/action/compose
 *        &subject=<title>
 *        &startdt=YYYY-MM-DDTHH:MM:SS
 *        &enddt=YYYY-MM-DDTHH:MM:SS
 *        &location=<address>
 *        &body=<description>
 *
 * Returns null when no recognizable calendar link is present OR when parsing
 * fails — caller (compose.ts) treats null as "this extractor had nothing"
 * and tries the next one. Never throws.
 */

import type { ExtractedEventData } from "../types";

const GCAL_HOSTS = ["calendar.google.com", "www.google.com"];
const OUTLOOK_HOSTS = ["outlook.live.com", "outlook.office.com", "outlook.office365.com"];

/**
 * Parse a single calendar URL into a partial event.
 * Returns null when the URL is not a recognized calendar template.
 */
export function parseCalendarLink(url: string): Partial<ExtractedEventData> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();

  if (GCAL_HOSTS.includes(host) && parsed.pathname.includes("/calendar/render")) {
    return parseGoogleCalendarTemplate(parsed);
  }

  if (OUTLOOK_HOSTS.includes(host) && parsed.pathname.includes("deeplink/compose")) {
    return parseOutlookDeeplink(parsed);
  }

  return null;
}

/**
 * Extract calendar links from a fetched HTML string. Looks for href values
 * matching the supported hosts; returns first 5 to keep parsing bounded.
 * Caller passes each through `parseCalendarLink` and merges results.
 */
export function findCalendarLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Match href values; tolerate single/double quotes + bare. Cap at 5 to
  // bound parsing on calendar pages that emit one link per row.
  const hrefRe = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  for (const match of html.matchAll(hrefRe)) {
    if (out.length >= 5) break;
    const raw = match[1] || match[2] || match[3];
    if (!raw) continue;
    // Cheap host filter before URL parse — avoids constructing URL for
    // every relative href on the page.
    if (
      !raw.includes("calendar.google.com") &&
      !raw.includes("outlook.live.com") &&
      !raw.includes("outlook.office")
    )
      continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function parseGoogleCalendarTemplate(url: URL): Partial<ExtractedEventData> | null {
  const action = url.searchParams.get("action");
  if (action !== "TEMPLATE") return null;
  const text = url.searchParams.get("text");
  const dates = url.searchParams.get("dates");
  const location = url.searchParams.get("location");
  const details = url.searchParams.get("details");

  // dates is the load-bearing field — without it the calendar link is
  // useless for date extraction (just a "add to calendar" stub).
  if (!dates) return null;

  const range = parseGcalDateRange(dates);
  if (!range) return null;

  const out: Partial<ExtractedEventData> = {
    startDate: range.startDate,
    endDate: range.endDate,
    startTime: range.startTime,
    endTime: range.endTime,
  };
  if (text) out.name = decodeFormPlus(text);
  if (location) {
    const loc = decodeFormPlus(location);
    out.venueAddress = loc;
    // Best-effort city/state from a US-style "Street, City, ST ZIP" tail.
    const cityStateMatch = loc.match(/,\s*([^,]+?),\s*([A-Z]{2})\s*(?:\d{5})?\s*(?:,\s*USA?)?$/);
    if (cityStateMatch) {
      out.venueCity = cityStateMatch[1].trim();
      out.venueState = cityStateMatch[2];
    }
  }
  if (details) {
    out.description = decodeFormPlus(details).slice(0, 1000);
  }
  return out;
}

function parseOutlookDeeplink(url: URL): Partial<ExtractedEventData> | null {
  const subject = url.searchParams.get("subject");
  const startdt = url.searchParams.get("startdt");
  const enddt = url.searchParams.get("enddt");
  const location = url.searchParams.get("location");
  const body = url.searchParams.get("body");

  if (!startdt) return null;

  const start = parseOutlookDateTime(startdt);
  const end = enddt ? parseOutlookDateTime(enddt) : start;
  if (!start) return null;

  const out: Partial<ExtractedEventData> = {
    startDate: start.date,
    endDate: end?.date ?? start.date,
    startTime: start.time,
    endTime: end?.time ?? null,
  };
  if (subject) out.name = subject.trim();
  if (location) {
    out.venueAddress = location.trim();
    const cityStateMatch = location.match(/,\s*([^,]+?),\s*([A-Z]{2})\s*(?:\d{5})?\s*$/);
    if (cityStateMatch) {
      out.venueCity = cityStateMatch[1].trim();
      out.venueState = cityStateMatch[2];
    }
  }
  if (body) out.description = body.trim().slice(0, 1000);
  return out;
}

/**
 * Google Calendar `dates` query param. Two shapes:
 *   - YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ  (with time, UTC)
 *   - YYYYMMDD/YYYYMMDD                    (all-day)
 * The timed variant occasionally drops the trailing Z (local-time emit).
 * Returns null when neither variant matches.
 */
function parseGcalDateRange(raw: string): {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
} | null {
  const [startRaw, endRaw] = raw.split("/");
  if (!startRaw) return null;

  const startParsed = parseGcalDateToken(startRaw);
  if (!startParsed) return null;
  const endParsed = endRaw ? parseGcalDateToken(endRaw) : startParsed;
  if (!endParsed) return null;

  return {
    startDate: startParsed.date,
    endDate: endParsed.date,
    startTime: startParsed.time,
    endTime: endParsed.time,
  };
}

function parseGcalDateToken(token: string): { date: string; time: string | null } | null {
  // All-day: YYYYMMDD
  const allDayMatch = token.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (allDayMatch) {
    return { date: `${allDayMatch[1]}-${allDayMatch[2]}-${allDayMatch[3]}`, time: null };
  }
  // Timed: YYYYMMDDTHHMMSS[Z]
  const timedMatch = token.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (timedMatch) {
    return {
      date: `${timedMatch[1]}-${timedMatch[2]}-${timedMatch[3]}`,
      time: `${timedMatch[4]}:${timedMatch[5]}`,
    };
  }
  return null;
}

function parseOutlookDateTime(raw: string): { date: string; time: string | null } | null {
  // ISO-ish: YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD
  const fullMatch = raw.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!fullMatch) return null;
  return {
    date: fullMatch[1],
    time: fullMatch[2] && fullMatch[3] ? `${fullMatch[2]}:${fullMatch[3]}` : null,
  };
}

/**
 * Decode form-style URL encoding: '+' represents space in query strings
 * (RFC 1866), but decodeURIComponent treats '+' as literal. Both Google
 * Calendar and Outlook deeplinks use the '+' convention.
 */
function decodeFormPlus(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).trim();
  } catch {
    // Malformed percent-encoding — best-effort fall back to raw with
    // pluses normalized. Never throw to caller.
    return raw.replace(/\+/g, " ").trim();
  }
}

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  formatDateOnly,
  formatDateRange as datetimeFormatDateRange,
  parseWallClockInVenueZone,
  formatIcsUtc,
  formatIcsVenueZone,
  getVtimezoneBlock,
  VENUE_TZ,
  VTIMEZONE_AMERICA_NEW_YORK,
} from "@/lib/datetime";

// Re-export from the canonical packages/utils so existing `@/lib/utils`
// imports keep working. Source of truth lives in @takemetothefair/utils.
import {
  createSlug,
  decodeHtmlEntities,
  unsafeSlug,
  appendSlugSegment,
  slugCandidates,
  type Slug,
} from "@takemetothefair/utils";
export { createSlug, decodeHtmlEntities, unsafeSlug, appendSlugSegment, slugCandidates };
export type { Slug };

import { SITE_HOSTNAME } from "@takemetothefair/constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * REMOVED 2026-08-26 (OPE-565). Use `containsCI` from `@/lib/db/contains-ci`.
 *
 * `sanitizeLikeInput` returned `input.replace(/[%_]/g, "\\$&")` — a backslash
 * escape that SQLite honours only alongside an `ESCAPE` clause, which Drizzle's
 * `like()` cannot emit. So at every one of its nine call sites the wildcard
 * survived into the pattern AND the pattern got two characters longer per
 * metacharacter: it made both problems it was named for slightly worse, while
 * reading as a guard.
 *
 * `containsCI` compiles to `instr(lower(col), ?) > 0`. There is nothing to
 * escape — `%` and `_` are literal to instr() — and no pattern-complexity
 * ceiling to cross. `scripts/check-d1-like-user-input.ts` fails the build if
 * this name comes back.
 */

/**
 * Generate bounds for prefix-based slug queries using string comparison.
 * This is more reliable than LIKE patterns which can fail with "pattern too complex" errors.
 *
 * Returns [lowerBound, upperBound] for use with: slug > lowerBound AND slug < upperBound
 * Uses ASCII ordering: '-' (45) < '/' (47) < '0' (48) < 'a' (97)
 */
export function getSlugPrefixBounds(baseSlug: string): [string, string] {
  // Lower bound: baseSlug- (exclusive, so we get baseSlug-* but not baseSlug- itself)
  const lowerBound = `${baseSlug}-`;
  // Upper bound: baseSlug/ (exclusive) - '/' comes after '-' in ASCII, before '0'
  // This captures all valid slug continuations (alphanumerics and hyphens)
  const upperBound = `${baseSlug}/`;
  return [lowerBound, upperBound];
}

/**
 * Find a unique slug by checking existing slugs with the same base.
 * Appends -2, -3, etc. if the base slug is taken.
 */
export function findUniqueSlug(baseSlug: Slug, existingSlugs: (string | null)[]): Slug {
  const existing = new Set(existingSlugs);
  if (!existing.has(baseSlug)) return baseSlug;
  let i = 2;
  while (existing.has(`${baseSlug}-${i}`)) i++;
  return appendSlugSegment(baseSlug, i);
}

/**
 * Display a date in the venue zone without a TZ label (date-only convention).
 * Delegates to the canonical formatter in `src/lib/datetime.ts`. Said "in UTC"
 * until OPE-482 moved date-only rendering to America/New_York.
 */
export function formatDate(date: Date | string): string {
  return formatDateOnly(date);
}

/**
 * Display a date range. Delegates to the canonical formatter; legacy "TBD"
 * contract is preserved.
 */
export function formatDateRange(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined
): string {
  return datetimeFormatDateRange(start, end);
}

export function formatDiscontinuousDates(days: { date: string }[]): string {
  if (!days?.length) return "TBD";
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  // OPE-482: hand the "YYYY-MM-DD" strings to the formatter directly. It anchors
  // bare calendar dates at noon UTC; the old `parseDateOnly` round-trip anchored
  // at midnight UTC, which renders a day early now that formatters are Eastern.
  if (sorted.length === 1) return formatDate(sorted[0].date);
  const first = formatDate(sorted[0].date);
  const last = formatDate(sorted[sorted.length - 1].date);
  if (!first || !last) return "TBD";
  return `${first} — ${last} (${sorted.length} dates)`;
}

/**
 * OPE-644 — re-export. The implementation moved to `@takemetothefair/utils`
 * because it existed HERE and in `mcp-server/src/helpers.ts`, and the two
 * diverged: OPE-482 fixed this copy to a noon-UTC anchor and left the Worker's
 * on midnight, which kept minting rows that render a day early in Eastern.
 * One implementation, in the package both artifacts already depend on.
 */
export { computePublicDates } from "@takemetothefair/utils";

// dollarsToCents and formatPrice live in @takemetothefair/utils so the main
// app and the MCP server use the same implementation. Re-exported here so
// existing `import { ... } from "@/lib/utils"` call sites keep working.
export { dollarsToCents, formatPrice } from "@takemetothefair/utils";

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length).trim() + "...";
}

export function formatAuthorName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^\s*admin(?:\s*user)?\s*[-–—:]\s*/i, "").trim();
  return cleaned || null;
}

// Calendar link generation utilities
interface CalendarEventParams {
  title: string;
  description?: string;
  location?: string;
  startDate: Date | string;
  endDate: Date | string;
  url?: string;
  // Cohort 7 (C1/U1, 2026-06-01) — RFC 5545 RRULE string (e.g.
  // "FREQ=WEEKLY;BYDAY=SA,SU;UNTIL=20260621T235959Z"). When supplied,
  // emitted as an RRULE line in the VEVENT so the user's calendar
  // (Apple Calendar / Outlook / Google) expands occurrences itself.
  // Without this, a single VEVENT spanning a multi-week recurring
  // series reads as one continuous block — not what the user wants
  // for a weekend-only fair.
  recurrenceRule?: string | null;
}

// Google's "dates" param uses compact ISO (YYYYMMDDTHHmmSSZ); strip
// dashes/colons from formatIcsUtc which already produces that form.
function formatDateForGoogle(date: Date | string | null): string {
  return formatIcsUtc(date);
}

export function generateGoogleCalendarUrl(params: CalendarEventParams): string {
  const { title, description, location, startDate, endDate, url } = params;

  const eventDescription = url
    ? `${description || ""}\n\nMore info: ${url}`.trim()
    : description || "";

  const searchParams = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${formatDateForGoogle(startDate)}/${formatDateForGoogle(endDate)}`,
    details: eventDescription,
    location: location || "",
  });

  return `https://www.google.com/calendar/render?${searchParams.toString()}`;
}

export function generateOutlookCalendarUrl(params: CalendarEventParams): string {
  const { title, description, location, startDate, endDate, url } = params;
  const start = new Date(startDate);
  const end = new Date(endDate);

  const eventDescription = url
    ? `${description || ""}\n\nMore info: ${url}`.trim()
    : description || "";

  const searchParams = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: eventDescription,
    location: location || "",
  });

  return `https://outlook.live.com/calendar/0/deeplink/compose?${searchParams.toString()}`;
}

export function generateICSContent(params: CalendarEventParams): string {
  const { title, description, location, startDate, endDate, url, recurrenceRule } = params;

  const eventDescription = url
    ? `${description || ""}\\n\\nMore info: ${url}`.trim()
    : description || "";

  // Filter out empty strings so the array .join doesn't emit blank
  // lines for the optional RRULE branch (some CalDAV servers reject
  // blank lines mid-VEVENT).
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meet Me at the Fair//EN",
    "BEGIN:VEVENT",
    `DTSTART:${formatIcsUtc(startDate)}`,
    `DTEND:${formatIcsUtc(endDate)}`,
    // Cohort 7 (C1/U1) — emit RRULE when recurrenceRule is supplied.
    // The caller is responsible for producing a valid RFC 5545 rule
    // string; we don't validate here.
    recurrenceRule ? `RRULE:${recurrenceRule}` : "",
    `SUMMARY:${title}`,
    `DESCRIPTION:${eventDescription.replace(/\n/g, "\\n")}`,
    `LOCATION:${location || ""}`,
    `URL:${url || ""}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.join("\r\n");
}

// Multi-day ICS generation for events with per-day schedules
interface EventDayForICS {
  date: string; // YYYY-MM-DD
  openTime: string; // HH:MM
  closeTime: string; // HH:MM
  notes?: string | null;
  closed?: boolean | null;
}

interface MultiDayCalendarParams {
  title: string;
  description?: string;
  location?: string;
  url?: string;
  eventDays: EventDayForICS[];
  /** Venue's IANA timezone (P3b). When omitted, falls back to VENUE_TZ
   *  (America/New_York) for backward compatibility with Eastern-US-only
   *  callers. Required for correct ICS output at non-Eastern venues. */
  venueTimezone?: string;
}

export function generateMultiDayICSContent(params: MultiDayCalendarParams): string {
  const { title, description, location, url, eventDays, venueTimezone = VENUE_TZ } = params;

  const openDays = eventDays.filter((d) => !d.closed);

  const eventDescription = url
    ? `${description || ""}\\n\\nMore info: ${url}`.trim()
    : description || "";

  // Per-day open/close times are wall-clock in the venue's zone, not UTC.
  // Emit them with TZID=<venueTimezone> + a matching VTIMEZONE block in
  // the calendar body so Google/Apple/Outlook compute the right local time
  // for attendees in any zone. If the venue's zone isn't in the registry
  // (e.g. a venue in a zone we haven't added a VTIMEZONE block for yet),
  // fall back to the Eastern block — incorrect for non-Eastern venues but
  // safer than emitting a TZID with no matching definition.
  const events = openDays.map((day) => {
    const startWallClock = parseWallClockInVenueZone(day.date, day.openTime, venueTimezone);
    const endWallClock = parseWallClockInVenueZone(day.date, day.closeTime, venueTimezone);
    const startIcs = formatIcsVenueZone(startWallClock, venueTimezone);
    const endIcs = formatIcsVenueZone(endWallClock, venueTimezone);
    const dayTitle = day.notes ? `${title} - ${day.notes}` : title;

    return [
      "BEGIN:VEVENT",
      // OPE-640 — deterministic, and deliberately NOT `crypto.randomUUID()`.
      //
      // Two separate bugs in the random version, one cosmetic and one not:
      //
      // 1. `crypto.randomUUID` does not exist below Safari 15.4 (2022-03) or
      //    Chrome 92 (2021-07), and this runs during RENDER inside a client
      //    component on every `/events/*` page — so a visitor on Safari 14 or
      //    Chrome 90 got the React error boundary INSTEAD OF THE PAGE. Nine
      //    logged occurrences, eight distinct events, accelerating. It is also
      //    `undefined` in any non-secure context.
      //
      // 2. An ICS UID is the calendar's IDENTITY for an entry. A fresh random
      //    UID on every render means re-downloading the .ics DUPLICATES every
      //    day in the user's calendar instead of updating it in place. So the
      //    random value was never right here, and guarding it with `?.()` plus
      //    a polyfill would have preserved a real defect.
      //
      // The event URL (falling back to the title) plus the day's date is
      // already unique per VEVENT and stable across renders, which is exactly
      // what RFC 5545 wants. `createSlug` keeps it free of characters that
      // would need escaping in a UID value.
      `UID:${day.date}-${createSlug(url || title)}@${SITE_HOSTNAME}`,
      startIcs ? `DTSTART;TZID=${startIcs.tzid}:${startIcs.value}` : "",
      endIcs ? `DTEND;TZID=${endIcs.tzid}:${endIcs.value}` : "",
      `SUMMARY:${dayTitle}`,
      `DESCRIPTION:${eventDescription.replace(/\n/g, "\\n")}`,
      `LOCATION:${location || ""}`,
      `URL:${url || ""}`,
      "END:VEVENT",
    ]
      .filter(Boolean)
      .join("\r\n");
  });

  const vtimezoneBlock = getVtimezoneBlock(venueTimezone) ?? VTIMEZONE_AMERICA_NEW_YORK;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meet Me at the Fair//EN",
    vtimezoneBlock,
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

export function generateMultiDayICSDataUrl(params: MultiDayCalendarParams): string {
  const icsContent = generateMultiDayICSContent(params);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
}

export function generateICSDataUrl(params: CalendarEventParams): string {
  const icsContent = generateICSContent(params);
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(icsContent)}`;
}

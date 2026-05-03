import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  formatDateOnly,
  formatDateRange as datetimeFormatDateRange,
  parseDateOnly,
  parseWallClockInVenueZone,
  formatIcsUtc,
  formatIcsVenueZone,
  VTIMEZONE_AMERICA_NEW_YORK,
} from "@/lib/datetime";

// Re-export from the canonical packages/utils so existing `@/lib/utils`
// imports keep working. Source of truth lives in @takemetothefair/utils.
export { createSlug, decodeHtmlEntities } from "@takemetothefair/utils";

import { SITE_HOSTNAME } from "@takemetothefair/constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function sanitizeLikeInput(input: string): string {
  return input.replace(/[%_]/g, "\\$&");
}

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
export function findUniqueSlug(baseSlug: string, existingSlugs: (string | null)[]): string {
  const existing = new Set(existingSlugs);
  if (!existing.has(baseSlug)) return baseSlug;
  let i = 2;
  while (existing.has(`${baseSlug}-${i}`)) i++;
  return `${baseSlug}-${i}`;
}

/**
 * Display a date in UTC without a TZ label (date-only field convention).
 * Delegates to the canonical formatter in `src/lib/datetime.ts`.
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
  if (sorted.length === 1) return formatDate(parseDateOnly(sorted[0].date) ?? new Date(NaN));
  const first = parseDateOnly(sorted[0].date);
  const last = parseDateOnly(sorted[sorted.length - 1].date);
  if (!first || !last) return "TBD";
  return `${formatDate(first)} — ${formatDate(last)} (${sorted.length} dates)`;
}

export function computePublicDates(eventDays: { date: string; vendorOnly?: boolean | null }[]): {
  publicStartDate: Date | null;
  publicEndDate: Date | null;
} {
  const publicDays = eventDays
    .filter((d) => !d.vendorOnly)
    .map((d) => d.date)
    .sort();

  if (publicDays.length === 0) {
    return { publicStartDate: null, publicEndDate: null };
  }

  return {
    publicStartDate: parseDateOnly(publicDays[0]),
    publicEndDate: parseDateOnly(publicDays[publicDays.length - 1]),
  };
}

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
  const { title, description, location, startDate, endDate, url } = params;

  const eventDescription = url
    ? `${description || ""}\\n\\nMore info: ${url}`.trim()
    : description || "";

  const icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meet Me at the Fair//EN",
    "BEGIN:VEVENT",
    `DTSTART:${formatIcsUtc(startDate)}`,
    `DTEND:${formatIcsUtc(endDate)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${eventDescription.replace(/\n/g, "\\n")}`,
    `LOCATION:${location || ""}`,
    `URL:${url || ""}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  return icsContent;
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
}

export function generateMultiDayICSContent(params: MultiDayCalendarParams): string {
  const { title, description, location, url, eventDays } = params;

  const openDays = eventDays.filter((d) => !d.closed);

  const eventDescription = url
    ? `${description || ""}\\n\\nMore info: ${url}`.trim()
    : description || "";

  // Per-day open/close times are wall-clock in the venue's zone, not UTC.
  // Emit them with TZID=America/New_York and include a VTIMEZONE block in
  // the calendar body so Google/Apple/Outlook compute the right local time
  // for attendees in any zone.
  const events = openDays.map((day) => {
    const startWallClock = parseWallClockInVenueZone(day.date, day.openTime);
    const endWallClock = parseWallClockInVenueZone(day.date, day.closeTime);
    const startIcs = formatIcsVenueZone(startWallClock);
    const endIcs = formatIcsVenueZone(endWallClock);
    const dayTitle = day.notes ? `${title} - ${day.notes}` : title;

    return [
      "BEGIN:VEVENT",
      `UID:${day.date}-${crypto.randomUUID()}@${SITE_HOSTNAME}`,
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

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meet Me at the Fair//EN",
    VTIMEZONE_AMERICA_NEW_YORK,
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

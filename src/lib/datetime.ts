/**
 * Canonical date/time helpers for the project.
 *
 * Storage policy:
 *   - All Date columns store UTC ms-epoch (the implicit codebase invariant).
 *   - Calendar dates (event start/end) are stored as midnight UTC.
 *   - Instants (createdAt, lastCrawledAt, etc.) are stored as the actual moment.
 *
 * Render policy:
 *   - Time-bearing fields render in the venue's local zone (`VENUE_TZ`) with
 *     the TZ abbreviation appended (e.g. "5:00 PM EDT").
 *   - Date-only fields render in UTC (the storage zone) WITHOUT a TZ label.
 *   - Audit instants render in the viewer's local zone on the client and in
 *     UTC on the server (use `formatTimestamp` vs `formatTimestampForServer`).
 *
 * All parsers return `null` on bad input; all formatters return `""` on bad
 * input. Nothing in this module ever throws on a `Date` value — that was the
 * root cause of the May 2026 Bing crash and the form-input shift bugs.
 */

export const VENUE_TZ = "America/New_York";

// ── Parsers ────────────────────────────────────────────────────────

/**
 * Parse an ISO date-only string ("YYYY-MM-DD") as midnight UTC.
 *
 * Does NOT use `new Date(s + "T00:00:00")` — that interprets the time in the
 * caller's local zone, which silently shifts the date for non-UTC environments.
 * Uses `Date.UTC(y, m, d)` so the result is identical regardless of where the
 * code runs (browser, Cloudflare Workers, Node.js with non-UTC tz).
 *
 * Rejects calendar-invalid dates: "2026-02-30", "2026-13-01", "2026-04-31".
 */
export function parseDateOnly(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Detect overflow: Date.UTC(2026, 1, 30) silently rolls to March 2.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Defensive multi-format parser for external-API responses.
 *
 * Subsumes the old `parseBingDate` + `schema-org/parseDate`. Accepts:
 *   - `null`/`undefined` → null
 *   - `Date` instance → returned as-is if valid, null if Invalid Date
 *   - finite number → treated as epoch ms (callers with epoch-seconds must
 *     multiply by 1000 first; we do not auto-detect because the cutoff is
 *     ambiguous)
 *   - WCF JSON `\/Date(epochMs)\/` with optional `±HHMM` timezone offset
 *     suffix (the variant Bing's GetCrawlStats actually returns)
 *   - ISO 8601 / RFC 3339 / any string `Date.parse` accepts
 *
 * Returns `null` on anything unparseable. Never throws.
 */
export function parseDateLoose(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw !== "string") return null;
  // WCF JSON with optional timezone-offset suffix:
  //   /Date(1714521600000)/         → epoch
  //   /Date(1777532400000-0700)/    → epoch (suffix is informational)
  const wcf = raw.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (wcf) {
    const d = new Date(parseInt(wcf[1], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Coerce a value that's already supposed to be a date (Date or ISO string)
 * into a Date. Identical contract to `parseDateLoose` today; the separate
 * name exists so callers can express "I have a known timestamp" vs "I'm
 * parsing arbitrary input" semantically.
 */
export function parseTimestamp(raw: unknown): Date | null {
  return parseDateLoose(raw);
}

// ── Internal formatter cache ────────────────────────────────────────
// Intl.DateTimeFormat construction is non-trivial; cache the formatters
// so hot paths don't pay the cost on every render.

const dateOnlyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
});

const eventDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: VENUE_TZ,
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const timeOfDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: VENUE_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const timestampUtcFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

function coerce(d: Date | string | number | null | undefined): Date | null {
  if (d == null) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  return parseDateLoose(d);
}

// ── Formatters ─────────────────────────────────────────────────────

/**
 * Date-only display, e.g. "Sat, Apr 30, 2026". Renders in UTC because event
 * dates are stored as midnight UTC. No timezone label — date-only fields
 * don't carry meaningful tz semantics.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatDateOnly(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return dateOnlyFmt.format(date);
}

/**
 * Date range, e.g. "Sat, Apr 30, 2026 - Sun, May 1, 2026".
 * Returns "TBD" if start is missing/invalid (legacy contract).
 * Returns just the start date if end is missing/invalid OR same calendar day.
 */
export function formatDateRange(
  start: Date | string | number | null | undefined,
  end: Date | string | number | null | undefined
): string {
  const startDate = coerce(start);
  if (!startDate || startDate.getTime() === 0) return "TBD";
  const endDate = coerce(end);
  if (!endDate || endDate.getTime() === 0) return formatDateOnly(startDate);
  // Compare calendar days in UTC (where the dates are conceptually anchored)
  if (
    startDate.getUTCFullYear() === endDate.getUTCFullYear() &&
    startDate.getUTCMonth() === endDate.getUTCMonth() &&
    startDate.getUTCDate() === endDate.getUTCDate()
  ) {
    return formatDateOnly(startDate);
  }
  return `${formatDateOnly(startDate)} - ${formatDateOnly(endDate)}`;
}

/**
 * Time-of-day in the venue's zone, e.g. "5:00 PM EDT" / "5:00 PM EST".
 * Used for event open/close times.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatTimeOfDay(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return timeOfDayFmt.format(date);
}

/**
 * Full event datetime in venue zone with TZ label, e.g.
 * "Sat, Apr 30, 2026, 5:00 PM EDT". For application deadlines and other
 * event-bearing timestamps where both date and time matter.
 */
export function formatEventDateTime(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return eventDateTimeFmt.format(date);
}

/**
 * Audit timestamp in the viewer's local zone with TZ label.
 *
 * IMPORTANT: when called server-side (Server Components, route handlers, etc.)
 * "viewer's local zone" is the server's zone, which on Cloudflare Workers is
 * UTC. For server-rendered audit timestamps prefer `formatTimestampForServer`
 * (explicit UTC), or wrap in a client component that re-renders on hydration.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatTimestamp(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  // No timeZone option: uses the runtime's local zone. Each call constructs
  // a new formatter because Intl caches assume a fixed locale+options pair;
  // we want this to track the viewer's zone if it ever changes.
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

/**
 * Audit timestamp explicitly in UTC, e.g. "Sat, Apr 30, 2026, 9:00 PM UTC".
 * Use for server-rendered audit timestamps where viewer-local rendering
 * would require client hydration.
 */
export function formatTimestampForServer(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return timestampUtcFmt.format(date);
}

// ── ISO helpers ────────────────────────────────────────────────────

/**
 * Convert a Date to "YYYY-MM-DD" using its UTC components.
 */
export function toIsoDateOnly(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Today as "YYYY-MM-DD" in UTC. Use this instead of inlining
 * `new Date().toISOString().slice(0, 10)` so the call site is greppable.
 */
export function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Yesterday as "YYYY-MM-DD" in UTC.
 */
export function yesterdayIsoUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Add (or subtract, with negative `days`) calendar days to a "YYYY-MM-DD"
 * string in UTC. Returns "YYYY-MM-DD".
 */
export function addDaysIso(iso: string, days: number): string {
  const d = parseDateOnly(iso);
  if (!d) return iso; // leave unchanged on bad input
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive day count between two "YYYY-MM-DD" strings in UTC.
 * Returns 0 if either is unparseable.
 */
export function diffDaysIso(startIso: string, endIso: string): number {
  const s = parseDateOnly(startIso);
  const e = parseDateOnly(endIso);
  if (!s || !e) return 0;
  return Math.round((e.getTime() - s.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

// ── Calendar (iCal/ICS) helpers ────────────────────────────────────

/**
 * Format a Date for an iCal `DTSTART:` / `DTEND:` field, in UTC.
 * Output: "20260430T170000Z" (RFC 5545 compliant UTC form).
 */
export function formatIcsUtc(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Format a Date for an iCal `DTSTART;TZID=...:` field in the venue's zone.
 * Output: { value: "20260430T130000", tzid: "America/New_York" }
 *
 * Pair with `VTIMEZONE_AMERICA_NEW_YORK` in the calendar body so attendees
 * in other zones get correct local times.
 */
export function formatIcsVenueZone(
  d: Date | string | number | null | undefined
): { value: string; tzid: string } | null {
  const date = coerce(d);
  if (!date) return null;
  // Render the wall-clock time in the venue's zone, then reformat into the
  // compact ICS form. We use Intl with explicit parts so we don't depend on
  // the runtime's local zone being UTC.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VENUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // Intl's hour: "2-digit" with hour12: false produces "24" at midnight on
  // some engines and "00" on others; normalize.
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return {
    value: `${get("year")}${get("month")}${get("day")}T${hour}${get("minute")}${get("second")}`,
    tzid: VENUE_TZ,
  };
}

/**
 * RFC 5545 VTIMEZONE block for America/New_York covering current US DST
 * rules (2nd Sunday March → 1st Sunday November). Embed in any VCALENDAR
 * that references TZID=America/New_York via `formatIcsVenueZone`.
 *
 * The block intentionally omits historical RDATE entries — modern calendar
 * clients (Google Calendar, Apple Calendar, Outlook) compute occurrences
 * from the RRULE and don't need a per-year override.
 */
export const VTIMEZONE_AMERICA_NEW_YORK = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

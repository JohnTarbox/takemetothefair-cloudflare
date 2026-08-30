/**
 * Canonical date/time helpers for the project.
 *
 * Storage policy:
 *   - All Date columns store UTC SECONDS-epoch — every `integer(..., { mode:
 *     "timestamp" })` column. Drizzle reads these as `new Date(value * 1000)`.
 *     The seconds-vs-ms distinction is load-bearing; see
 *     `drizzle/0045_fix_timestamp_columns_back_to_seconds.sql` for the
 *     corrective migration that established this invariant.
 *     (`mode: "timestamp_ms"` would store ms-epoch — the project does not use it.)
 *   - Calendar dates (event start/end) are stored anchored at NOON UTC — the
 *     `normalizeEventDate` convention (OPE-307). This line used to read
 *     "midnight UTC"; that was already false when written and is what the
 *     OPE-482 note below is about. Legacy midnight-UTC rows were re-anchored by
 *     drizzle/0232.
 *   - Instants (createdAt, lastCrawledAt, etc.) are stored as the actual moment.
 *
 * Render policy (OPE-482, 2026-08-25 — this changed; read the note below):
 *   - Time-bearing fields render in the venue's local zone (`VENUE_TZ`) with
 *     the TZ abbreviation appended (e.g. "5:00 PM EDT").
 *   - Date-only fields render in `VENUE_TZ` WITHOUT a TZ label.
 *   - Audit instants render in the viewer's local zone on the client and in
 *     UTC on the server (use `formatTimestamp` vs `formatTimestampForServer`).
 *
 * Why date-only rendering moved from UTC to Eastern (OPE-482):
 *   The old policy rendered date-only fields in UTC and justified it with the
 *   storage invariant above — "calendar dates are stored as midnight UTC". That
 *   invariant was never true of the whole corpus. Measured 2026-08-25 across
 *   1,469 APPROVED events, `end_date` carried at least four conventions:
 *
 *     12:00:00Z   987 rows   the canonical anchor (`normalizeEventDate`)
 *     03:59:59Z    15 rows   23:59:59 Eastern — end of the last day
 *     00:00:00Z    20 rows   midnight UTC, i.e. "this calendar date" literally
 *     00:15–03:00Z  6 rows   real Eastern closing times (8:15pm–11pm)
 *     04:00:00Z     2 rows   midnight Eastern (mismatches in the EST half)
 *
 *   43 of those rows rendered an end date ONE DAY LATE under a UTC render,
 *   including 12 fairs that had not happened yet. Rendering in Eastern is
 *   correct for every convention EXCEPT the literal midnight-UTC one, so
 *   drizzle/0232 re-anchored those 20 rows to 12:00Z first and the writers that
 *   produced them were fixed in the same PR. Noon UTC is deliberately the
 *   anchor: 12:00Z is 07:00/08:00 ET, so the Eastern calendar date and the UTC
 *   calendar date agree, which is what makes the anchor timezone-safe in both
 *   directions.
 *
 *   `get_data_health_report`'s `midnightUtcDateAnchors` invariant watches for
 *   the midnight-UTC convention returning — if it does, those rows render a day
 *   EARLY, which is the failure mode this policy trades for the old one.
 *
 * Bare "YYYY-MM-DD" strings (e.g. `event_days.date`) are calendar dates, not
 * instants. Every formatter anchors them at NOON UTC before rendering, so they
 * display as the same calendar day in any zone. Pass such a string directly —
 * do NOT route it through `parseDateOnly` first, which anchors at midnight UTC
 * and therefore renders one day early in Eastern.
 *
 * All parsers return `null` on bad input; all formatters return `""` on bad
 * input. Nothing in this module ever throws on a `Date` value — that was the
 * root cause of the May 2026 Bing crash and the form-input shift bugs.
 */

export const VENUE_TZ = "America/New_York";

// ── Branded types ──────────────────────────────────────────────────
//
// `DateOnly` and `Instant` mirror the `Slug`/`unsafeSlug` pattern from
// `@takemetothefair/utils`. Background: every `mode: "timestamp"` column
// produces a JS `Date`, but the column's semantics fall into two camps:
//
//   - Calendar dates anchored at midnight UTC (events.startDate, endDate,
//     applicationDeadline). Calling `.getHours()` or `.toLocaleTimeString()`
//     on these is a category error — there is no time of day. On CF Workers
//     (UTC) the result silently looks correct ("12:00 AM") but is
//     meaningless.
//   - Actual instants (createdAt, lastCrawledAt, lastSyncedAt, …) where
//     time-of-day IS meaningful.
//
// Today the brand is enforced at the canonical-helper boundary: `parseDateOnly`
// returns `DateOnly`, and `formatTimeOfDay` / `formatEventDateTime` refuse
// `DateOnly` at compile time via the `Instant` constraint. Applying
// `.$type<DateOnly>()` to the schema columns would catch a broader class of
// read-side mistakes (e.g. directly passing `event.startDate` to a time-of-day
// formatter), but ripples into every event-write site (~30 files: scrapers,
// API routes, tests) which all currently pass plain `Date`. That sweep is
// deferred to a follow-up — see the date/time audit plan.
//
// The `dateOnlyBrand` symbol is `declare const` (no runtime). `unsafeDateOnly`
// is the searchable boundary cast for places where a `DateOnly` is being
// reconstituted from a JSON or DB value not yet flowing through the typed
// pipeline.

declare const dateOnlyBrand: unique symbol;

/**
 * A `Date` representing midnight UTC of a calendar day — the events.startDate
 * shape. Carries the brand so time-of-day formatters can refuse it.
 */
export type DateOnly = Date & { readonly [dateOnlyBrand]: true };

/**
 * A `Date` that is NOT a `DateOnly` — i.e. an actual instant. The negative
 * brand (`?: never`) means a plain `Date` satisfies it (no property present)
 * but a `DateOnly` does not (its `true` brand is not assignable to `never`).
 */
export type Instant = Date & { readonly [dateOnlyBrand]?: never };

/**
 * Boundary cast. Use at JSON/DB-read sites that produce a `Date` representing
 * a date-only value but haven't been retyped to `DateOnly` yet. Searchable.
 */
export function unsafeDateOnly(d: Date): DateOnly {
  return d as DateOnly;
}

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
export function parseDateOnly(s: unknown): DateOnly | null {
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
  return unsafeDateOnly(d);
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

/**
 * Combine a "YYYY-MM-DD" date and an "HH:MM" time, interpret them as
 * wall-clock in the venue's zone (`VENUE_TZ`), and return the corresponding
 * UTC `Date`.
 *
 * Use this for any user-entered datetime that represents "what the clock on
 * the wall at the venue says." E.g. promoter enters "April 30 at 9:00 AM";
 * we want this stored as 9:00 AM ET → 13:00 UTC (in EDT, summer) or 14:00
 * UTC (in EST, winter), regardless of where the promoter's browser thinks
 * it lives.
 *
 * Algorithm: build a tentative UTC ms with the same components, format it
 * in the target zone to discover what wall-clock that ms-epoch represents,
 * then offset by the difference. Standard "fold" approach, DST-safe except
 * at the precise transition instant (which is ambiguous anyway).
 *
 * Returns `null` on unparseable inputs.
 */
export function parseWallClockInVenueZone(
  dateIso: string,
  timeIso: string,
  tz: string = VENUE_TZ
): Date | null {
  if (typeof dateIso !== "string" || typeof timeIso !== "string") return null;
  const dm = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = timeIso.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const year = parseInt(dm[1], 10);
  const month = parseInt(dm[2], 10);
  const day = parseInt(dm[3], 10);
  const hour = parseInt(tm[1], 10);
  const minute = parseInt(tm[2], 10);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const targetMs = Date.UTC(year, month - 1, day, hour, minute);
  if (isNaN(targetMs)) return null;
  // Two passes converge across DST transitions: first pass uses the offset
  // observed at the tentative ms; second pass uses the offset observed at the
  // first-pass result, which catches cases where the answer crosses a DST
  // boundary (e.g. wall-clock 3:00 AM on spring-forward Sunday — the tentative
  // lands in EST but the answer is in EDT). DST-exempt zones (Saskatchewan,
  // Arizona) converge after pass 1.
  let result = targetMs;
  const fmt = cachedFmt("parseWallClock", tz, DEFAULT_LOCALE, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  for (let i = 0; i < 2; i++) {
    const parts = fmt.formatToParts(new Date(result));
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    let observedHour = get("hour");
    if (observedHour === 24) observedHour = 0;
    const observedMs = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      observedHour,
      get("minute")
    );
    const offsetMs = observedMs - result;
    result = targetMs - offsetMs;
  }
  return new Date(result);
}

// ── Internal formatter cache ────────────────────────────────────────
// Intl.DateTimeFormat construction is non-trivial; cache formatters so
// hot paths don't pay the cost on every render. Cache key is
// `${name}|${tz}|${locale}` — name disambiguates the option set (e.g.
// `dateOnly` vs `dateMedium` differ in whether weekday is shown), tz and
// locale capture per-venue / per-language variation (P3a, 2026-06-06).
// For the dominant America/New_York + en-US case the cache hits after
// the first render in the lifetime of the worker, so this is no slower
// than the prior const-formatter shape.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function cachedFmt(
  name: string,
  tz: string,
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${name}|${tz}|${locale}`;
  let fmt = fmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz });
    fmtCache.set(key, fmt);
  }
  return fmt;
}

// Cross-zone default. Existing call sites pass no tz/locale → these
// defaults reproduce the pre-P3a Eastern-US render byte-for-byte.
const DEFAULT_LOCALE = "en-US";

/** Bare calendar date with no time component — `event_days.date`, form inputs,
 *  the `"YYYY-MM-DD"` shape every extractor emits. */
const BARE_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a formatter input to a `Date`.
 *
 * A bare "YYYY-MM-DD" string is a CALENDAR DATE, not an instant, so it is
 * anchored at NOON UTC rather than the midnight UTC `new Date(s)` would give.
 * Noon is the zone-safe anchor (12:00Z = 07:00/08:00 ET), so the string renders
 * as the same calendar day whether the formatter is pointed at UTC or Eastern.
 * Anchoring at midnight instead is precisely the OPE-482 defect one level down:
 * midnight UTC is 8pm Eastern the PREVIOUS day.
 *
 * This mirrors `normalizeEventDate` in @takemetothefair/utils, which applies the
 * same noon anchor on the write side. Read and write now agree by construction.
 */
function coerce(d: Date | string | number | null | undefined): Date | null {
  if (d == null) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  if (typeof d === "string" && BARE_CALENDAR_DATE.test(d)) {
    const anchored = parseDateOnly(d);
    if (!anchored) return null; // calendar-invalid, e.g. "2026-02-30"
    return new Date(anchored.getTime() + 12 * 60 * 60 * 1000);
  }
  return parseDateLoose(d);
}

/**
 * The calendar y/m/d a `Date` falls on in `tz`. Used wherever two dates must be
 * compared as calendar days rather than as instants — the UTC components are
 * the wrong answer once rendering is Eastern.
 */
function calendarPartsIn(d: Date, tz: string): { y: number; m: number; day: number } {
  const parts = cachedFmt("calendarParts", tz, "en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/**
 * Has `date`'s CALENDAR DAY already finished, as of `now`, in zone `tz`?
 *
 * OPE-651 — the date gates asked `endDate.getTime() < now.getTime()`, which is
 * an instant comparison against a value that means a DAY. Event dates are
 * anchored at noon UTC, so that predicate flipped to "past" at 12:00Z — 08:00
 * Eastern — on the event's own morning.
 *
 * A car show running 10:00-15:00 EDT was therefore flagged `end_date_in_past`
 * about two hours BEFORE it opened, and stayed flagged all day. For a directory
 * whose entire value on the day of a fair is telling someone it is on today,
 * that is the wrong hour to call it over.
 *
 * An event is not past until its end DATE has passed where the event happens,
 * so this compares calendar days in `tz` and ignores time-of-day entirely.
 * DST-safe: the zone conversion is done by `Intl`, not by arithmetic.
 */
export function hasCalendarDayPassed(date: Date, now: Date, tz: string = VENUE_TZ): boolean {
  const d = calendarPartsIn(date, tz);
  const n = calendarPartsIn(now, tz);
  if (d.y !== n.y) return d.y < n.y;
  if (d.m !== n.m) return d.m < n.m;
  return d.day < n.day;
}

// ── Formatters ─────────────────────────────────────────────────────

/**
 * Date-only display, e.g. "Sat, Apr 30, 2026". Renders in UTC because event
 * dates are stored as midnight UTC. No timezone label — date-only fields
 * don't carry meaningful tz semantics.
 *
 * Optional `locale` for venue-specific display (e.g. "sam. 30 avr. 2026"
 * with `"fr-CA"`). Defaults to `"en-US"` for backward compatibility.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatDateOnly(
  d: Date | string | number | null | undefined,
  locale: string = DEFAULT_LOCALE,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("dateOnly", tz, locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
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
  // Compare calendar days in the zone we RENDER in (OPE-482). Comparing UTC
  // components while rendering Eastern is how you get "Sep 26, 2026 - Sep 26,
  // 2026": a same-Eastern-day pair (12:00Z start, 03:59:59Z-next-day end) reads
  // as two different UTC days, so the range branch fires and prints the same
  // formatted date twice.
  const s = calendarPartsIn(startDate, VENUE_TZ);
  const e = calendarPartsIn(endDate, VENUE_TZ);
  if (s.y === e.y && s.m === e.m && s.day === e.day) {
    return formatDateOnly(startDate);
  }
  return `${formatDateOnly(startDate)} - ${formatDateOnly(endDate)}`;
}

/**
 * Date-only display without weekday, e.g. "Apr 30, 2026". UTC-anchored.
 * Use when the weekday is noise — compact card metadata, table rows,
 * deadline labels, blog publish dates. Existing call sites previously
 * stripped the weekday from `formatDateOnly` output via regex; this is the
 * direct form.
 *
 * Optional `locale` — see `formatDateOnly`.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatDateMedium(
  d: Date | string | number | null | undefined,
  locale: string = DEFAULT_LOCALE,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("dateMedium", tz, locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * Date-only display with long month name, e.g. "April 30, 2026". UTC-anchored.
 * Use for marketing-style display (blog post bylines, hero metadata).
 *
 * Optional `locale` — see `formatDateOnly`.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatDateLong(
  d: Date | string | number | null | undefined,
  locale: string = DEFAULT_LOCALE,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("dateLong", tz, locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

/**
 * Compact date display without year, e.g. "Apr 30". UTC-anchored.
 * Use for near-term chips/badges where the year is implied (the deadline
 * chip on event cards: "Applies by Apr 30").
 *
 * Optional `locale` — see `formatDateOnly`.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatDateShort(
  d: Date | string | number | null | undefined,
  locale: string = DEFAULT_LOCALE,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("dateShort", tz, locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * Month abbreviation only, e.g. "Apr". UTC-anchored.
 * Use for calendar-style badges where the day number is rendered as a
 * separate visual element (e.g. event-card date badge: month on top,
 * day-of-month below).
 *
 * Optional `locale` — see `formatDateOnly`.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatMonthShort(
  d: Date | string | number | null | undefined,
  locale: string = DEFAULT_LOCALE,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("monthShort", tz, locale, {
    month: "short",
  }).format(date);
}

/**
 * Time-of-day in the venue's zone, e.g. "5:00 PM EDT" / "5:00 PM EST".
 * Used for event open/close times.
 *
 * Optional `tz` (IANA) + `locale` (BCP 47) — defaults to America/New_York
 * + en-US for backward compatibility. When threaded through from a venue
 * row with timezone='America/Halifax', produces "5:00 PM ADT" / "AST".
 *
 * Refuses `DateOnly` at compile time — there is no time of day on a
 * midnight-UTC calendar anchor. Pass a real instant (e.g. event_day open/
 * close, application_deadline if it ever becomes time-bearing) or coerce
 * via `unsafeDateOnly` explicitly if you really mean it.
 *
 * Returns `""` on null / Invalid Date.
 */
export function formatTimeOfDay(
  d: Instant | string | number | null | undefined,
  tz: string = VENUE_TZ,
  locale: string = DEFAULT_LOCALE
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("timeOfDay", tz, locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

/**
 * Full event datetime in venue zone with TZ label, e.g.
 * "Sat, Apr 30, 2026, 5:00 PM EDT". For application deadlines and other
 * event-bearing timestamps where both date and time matter.
 *
 * Optional `tz` + `locale` — see `formatTimeOfDay`.
 *
 * Refuses `DateOnly` at compile time for the same reason `formatTimeOfDay`
 * does — there is no time component on a calendar anchor.
 */
export function formatEventDateTime(
  d: Instant | string | number | null | undefined,
  tz: string = VENUE_TZ,
  locale: string = DEFAULT_LOCALE
): string {
  const date = coerce(d);
  if (!date) return "";
  return cachedFmt("eventDateTime", tz, locale, {
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
  return cachedFmt("timestampUtc", "UTC", DEFAULT_LOCALE, {
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

// ── ISO helpers ────────────────────────────────────────────────────

/**
 * Convert a Date to "YYYY-MM-DD" using its UTC components.
 *
 * ⚠️ This is the STORAGE-side helper: it reports the UTC calendar date, which
 * is what round-trips through `parseDateOnly` / `normalizeEventDate`. It is the
 * wrong helper for anything a human or a calendar client will read — a row
 * stored at `2026-09-27T03:59:59Z` (23:59:59 Eastern on Sep 26) reports
 * "2026-09-27" here. For display, ICS export, and any surface that must agree
 * with the rendered page, use `toIsoDateOnlyInVenueZone` (OPE-482).
 */
export function toIsoDateOnly(d: Date | string | number | null | undefined): string {
  const date = coerce(d);
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * "YYYY-MM-DD" of an instant as it falls in the venue's zone — the display
 * twin of `toIsoDateOnly`, and the one that agrees with what the page renders.
 *
 * Use for ICS/calendar export, `<input type="date">` values on admin forms, and
 * anywhere a date string is derived from a stored instant for a human to read.
 *
 * Returns `""` on null / Invalid Date.
 */
export function toIsoDateOnlyInVenueZone(
  d: Date | string | number | null | undefined,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  const { y, m, day } = calendarPartsIn(date, tz);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The calendar YEAR an instant falls in, in the venue's zone.
 *
 * `getUTCFullYear()` is wrong for the occurrence-year routes and canonical URLs:
 * a New Year's Eve event ending `2026-12-31 23:59:59` Eastern is stored at
 * `2027-01-01T04:59:59Z`, whose UTC year is 2027. Returns `null` on bad input.
 */
export function getVenueZoneYear(
  d: Date | string | number | null | undefined,
  tz: string = VENUE_TZ
): number | null {
  const date = coerce(d);
  if (!date) return null;
  return calendarPartsIn(date, tz).y;
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
 * Format a Date as an ISO 8601 string in the venue's zone with the proper
 * `±HH:MM` offset, e.g. "2026-04-30T09:00:00-04:00".
 *
 * Use for JSON-LD sub-event `startDate`/`endDate` fields where floating
 * times (no offset) are ambiguous and schema.org best practice is to
 * include the offset. Returns "" on Invalid Date.
 */
export function formatIsoInVenueZone(
  d: Date | string | number | null | undefined,
  tz: string = VENUE_TZ
): string {
  const date = coerce(d);
  if (!date) return "";
  const parts = cachedFmt("isoInVenueZone", tz, DEFAULT_LOCALE, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  // `longOffset` produces "GMT-04:00" / "GMT+05:00"; strip the GMT prefix.
  // Some engines return just the offset; tolerate either.
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const offset = tzPart.replace(/^GMT/, "") || "Z";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}${offset}`;
}

/**
 * Format a Date for an iCal `DTSTART;TZID=...:` field in the venue's zone.
 * Output: { value: "20260430T130000", tzid: "America/New_York" }
 *
 * Pair with `VTIMEZONE_AMERICA_NEW_YORK` in the calendar body so attendees
 * in other zones get correct local times.
 */
export function formatIcsVenueZone(
  d: Date | string | number | null | undefined,
  tz: string = VENUE_TZ
): { value: string; tzid: string } | null {
  const date = coerce(d);
  if (!date) return null;
  // Render the wall-clock time in the venue's zone, then reformat into the
  // compact ICS form. We use Intl with explicit parts so we don't depend on
  // the runtime's local zone being UTC.
  const parts = cachedFmt("icsVenueZone", tz, DEFAULT_LOCALE, {
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
    tzid: tz,
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

/**
 * Registry of RFC 5545 VTIMEZONE blocks per IANA zone. Phase 3a (2026-06-06)
 * ships only the America/New_York entry — that's the only zone with a venue
 * today. When a non-Eastern venue is created (Phase 3b or later), the
 * corresponding block must be added here before its ICS export can carry a
 * TZID reference; otherwise `getVtimezoneBlock` returns null and the caller
 * must fall back to UTC (`formatIcsUtc`) or floating time.
 *
 * The intentional simplicity of this shape — a flat record, not a builder —
 * is so future-readers can audit "what zones do we support for ICS export?"
 * by reading the keys of one constant.
 */
export const VTIMEZONE_REGISTRY: Record<string, string> = {
  "America/New_York": VTIMEZONE_AMERICA_NEW_YORK,
  // Future entries (add when the first non-Eastern venue is created):
  //   "America/Halifax":   VTIMEZONE_AMERICA_HALIFAX,
  //   "America/St_Johns":  VTIMEZONE_AMERICA_ST_JOHNS,
  //   "America/Regina":    VTIMEZONE_AMERICA_REGINA,   // DST-exempt
  //   "America/Phoenix":   VTIMEZONE_AMERICA_PHOENIX,  // DST-exempt
};

/**
 * Look up the RFC 5545 VTIMEZONE block for an IANA zone. Returns `null`
 * if the zone isn't in the registry — caller decides whether to fall
 * back to floating times, refuse the ICS export, or convert to UTC.
 */
export function getVtimezoneBlock(tz: string): string | null {
  return VTIMEZONE_REGISTRY[tz] ?? null;
}

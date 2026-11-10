/**
 * OPE-1617 — universal iCalendar (RFC 5545) reader.
 *
 * One parser for every published-calendar source an organizer can give us:
 * WordPress calendar plugins (The Events Calendar's `?ical=1` export),
 * Squarespace / Wix / church and grange calendars, and the public iCal address
 * of a shared Google or Outlook/365 calendar. Output is the same `FeedEvent`
 * the OPE-1613 pipeline already ingests, so provenance, pins, inclusion and
 * discrepancies apply unchanged.
 *
 * TIME. We keep the organizer's LOCAL wall time ("2026-03-19" + "04:30") and
 * never round-trip it through a Date, for the reason tec.ts gives: a wrong
 * offset is exactly the error a feed discrepancy exists to catch, so the reader
 * must not manufacture one.
 *   - `DTSTART;TZID=America/New_York:20260319T043000` → 04:30 local, as written.
 *   - `DTSTART:20260319T203000Z` (UTC, which Google uses) → converted to the
 *     calendar's zone (X-WR-TIMEZONE, else the caller's default) with Intl,
 *     which carries the real DST rules. We do NOT read VTIMEZONE blocks for
 *     this: they are often partial (OHTM's covers only 2025–2027), and a TZID
 *     that names an IANA zone is a better source than a truncated copy of it.
 *   - A floating time (no TZID, no Z) is local in the calendar's zone.
 *   - Outlook's Windows zone names ("Eastern Standard Time") map to IANA.
 *   - `VALUE=DATE` is all-day; its DTEND is EXCLUSIVE, so a one-day event's
 *     end date is its start date.
 *
 * RECURRENCE. RRULE is expanded in local wall-clock days (FREQ DAILY / WEEKLY /
 * MONTHLY / YEARLY with INTERVAL, COUNT, UNTIL, BYDAY incl. ordinals like 2SA or
 * -1SU, BYMONTHDAY, BYMONTH). EXDATE removes an instance. A VEVENT carrying
 * RECURRENCE-ID replaces the instance it names — including with
 * STATUS:CANCELLED, which cancels just that date. Each instance's external id
 * is `<UID>::<original local date>`, stable across reads, so a later read that
 * no longer carries an instance is detectable as a DROP (ingest.ts). A rule
 * part we do not expand (BYSETPOS, BYHOUR, BYWEEKNO, BYYEARDAY, sub-daily FREQ)
 * keeps the first instance only and says so in `warnings` — never a silent
 * guess at a schedule.
 *
 * CHANGE DETECTION. UID is the stable key; SEQUENCE and LAST-MODIFIED ride on
 * the FeedEvent so the item snapshot records them. When a calendar carries two
 * plain VEVENTs with one UID (no RECURRENCE-ID), the higher SEQUENCE wins.
 */
import { htmlToText, type FeedEvent, type FeedVenue } from "./tec.js";

/** A content line, after unfolding: NAME;PARAM=V:VALUE. */
export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

/** RFC 5545 §3.1: a line starting with a space or tab continues the previous one. */
export function unfoldLines(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else if (line.trim() !== "") {
      out.push(line);
    }
  }
  return out;
}

/** Split NAME;P1=a;P2="b:c":VALUE — a colon inside a quoted param is not the separator. */
export function parseContentLine(line: string): IcsProp | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = "";
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ";" && !inQuote) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = parts[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
  }
  return { name, params, value };
}

export function parseIcs(text: string): IcsComponent {
  const root: IcsComponent = { type: "ROOT", props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const line of unfoldLines(text)) {
    const p = parseContentLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const c: IcsComponent = { type: p.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(p);
    }
  }
  return root;
}

/** TEXT value unescape (§3.3.11). */
export function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// ---------------------------------------------------------------- time zones

/** Outlook / Exchange publish Windows zone names. The ones a New England calendar can carry. */
const WINDOWS_ZONES: Record<string, string> = {
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "atlantic standard time": "America/Halifax",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  utc: "UTC",
};

const validZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * A TZID as a usable IANA zone, or null. Strips the "/mozilla.org/…/" style
 * prefixes some exporters add, and maps Windows names.
 */
export function resolveTzid(tzid: string | null | undefined): string | null {
  if (!tzid) return null;
  let t = tzid.trim().replace(/^"(.*)"$/, "$1");
  const win = WINDOWS_ZONES[t.toLowerCase()];
  if (win) return win;
  // "/mozilla.org/20050126_1/America/New_York" → "America/New_York"
  const m = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(t);
  if (m && !validZone(t)) t = m[1];
  return validZone(t) ? t : null;
}

/** A UTC instant → local wall date + time in `tz`. */
export function utcToLocal(ms: number, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

// ---------------------------------------------------------- local wall time

/** A local wall-clock moment. `time` null = an all-day (DATE) value. */
export interface LocalTime {
  date: string;
  time: string | null;
}

const DAY_MS = 86_400_000;
/** A local date as a day number, for arithmetic only (never displayed). */
const dayNum = (ymd: string): number =>
  Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY_MS;
const fromDayNum = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number): string => fromDayNum(dayNum(ymd) + n);
const minutesOf = (t: LocalTime): number => {
  if (!t.time) return dayNum(t.date) * 1440;
  const [h, m] = t.time.split(":").map(Number);
  return dayNum(t.date) * 1440 + h * 60 + m;
};
const fromMinutes = (mins: number): LocalTime => {
  const d = Math.floor(mins / 1440);
  const r = mins - d * 1440;
  return {
    date: fromDayNum(d),
    time: `${String(Math.floor(r / 60)).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}`,
  };
};

/**
 * One DATE / DATE-TIME value → local wall time.
 * Returns the zone it is local to (null for a floating value with no default).
 */
export function parseIcsDateValue(
  prop: IcsProp,
  calendarTz: string | null
): (LocalTime & { tz: string | null }) | null {
  const v = prop.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || prop.params.VALUE?.toUpperCase() === "DATE") {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, tz: calendarTz };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    const tz = calendarTz ?? "UTC";
    const local = utcToLocal(Date.UTC(+y, +mo - 1, +d, +h, +mi), tz);
    return { ...local, tz };
  }
  const tz = resolveTzid(prop.params.TZID) ?? calendarTz;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, tz };
}

/** ISO 8601 duration (P1D, PT2H30M, P1W) → minutes. */
export function parseDurationMinutes(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    v.trim()
  );
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const mins =
    (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 1440 +
    +(m[4] ?? 0) * 60 +
    +(m[5] ?? 0) +
    Math.floor(+(m[6] ?? 0) / 60);
  return sign * mins;
}

// ---------------------------------------------------------------- RRULE

export interface Rrule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: string | null; // local "YYYY-MM-DD"
  byDay: Array<{ n: number | null; wd: number }>; // wd: 0=SU … 6=SA
  byMonthDay: number[];
  byMonth: number[];
  /** Rule parts present that this expander does not implement. */
  unsupported: string[];
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function parseRrule(value: string, calendarTz: string | null): Rrule | null {
  const kv: Record<string, string> = {};
  for (const part of value.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
  }
  const freq = kv.FREQ?.toUpperCase();
  const unsupported: string[] = [];
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    if (!freq) return null;
    unsupported.push(`FREQ=${freq}`);
  }
  for (const k of ["BYSETPOS", "BYHOUR", "BYMINUTE", "BYSECOND", "BYWEEKNO", "BYYEARDAY"]) {
    if (kv[k]) unsupported.push(k);
  }
  let until: string | null = null;
  if (kv.UNTIL) {
    const u = parseIcsDateValue({ name: "UNTIL", params: {}, value: kv.UNTIL }, calendarTz);
    until = u?.date ?? null;
  }
  const byDay = (kv.BYDAY ?? "")
    .split(",")
    .map((s) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ n: m[1] ? Number(m[1]) : null, wd: WEEKDAYS.indexOf(m[2].toUpperCase()) }));
  const nums = (s: string | undefined) =>
    (s ?? "")
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n !== 0);
  return {
    freq: (unsupported.some((u) => u.startsWith("FREQ")) ? "DAILY" : freq) as Rrule["freq"],
    interval: Math.max(1, Number(kv.INTERVAL) || 1),
    count: kv.COUNT ? Math.max(0, Number(kv.COUNT) || 0) : null,
    until,
    byDay,
    byMonthDay: nums(kv.BYMONTHDAY),
    byMonth: nums(kv.BYMONTH).filter((n) => n >= 1 && n <= 12),
    unsupported,
  };
}

const weekdayOf = (ymd: string): number => new Date(dayNum(ymd) * DAY_MS).getUTCDay();
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Does `ymd` satisfy a BYDAY entry within its month (ordinal) or plainly (no ordinal)? */
function matchesByDayInMonth(ymd: string, e: { n: number | null; wd: number }): boolean {
  if (weekdayOf(ymd) !== e.wd) return false;
  if (e.n === null) return true;
  const day = +ymd.slice(8, 10);
  const dim = daysInMonth(+ymd.slice(0, 4), +ymd.slice(5, 7));
  return e.n > 0 ? Math.ceil(day / 7) === e.n : Math.ceil((dim - day + 1) / 7) === -e.n;
}

function matchesMonthDay(ymd: string, list: number[]): boolean {
  const day = +ymd.slice(8, 10);
  const dim = daysInMonth(+ymd.slice(0, 4), +ymd.slice(5, 7));
  return list.some((n) => (n > 0 ? n === day : dim + n + 1 === day));
}

/** Monday-based week index, for WEEKLY;INTERVAL (WKST=MO, the RFC default). */
const mondayWeek = (ymd: string): number => Math.floor((dayNum(ymd) + 3) / 7);

/**
 * Expand a rule into instance START dates (local), from `dtstart` to `windowEnd`.
 * COUNT counts from dtstart, not from the window, so instances before the window
 * still use up the count. Bounded by `maxScanDays`.
 */
export function expandRrule(
  dtstartDate: string,
  rule: Rrule,
  windowEnd: string,
  maxScanDays = 4000
): string[] {
  if (rule.unsupported.length) return [dtstartDate];
  const out: string[] = [];
  const startY = +dtstartDate.slice(0, 4);
  const startM = +dtstartDate.slice(5, 7);
  const startD = +dtstartDate.slice(8, 10);
  const startWd = weekdayOf(dtstartDate);
  const last = rule.until && rule.until < windowEnd ? rule.until : windowEnd;
  const scanEnd = Math.min(dayNum(last), dayNum(dtstartDate) + maxScanDays);
  for (let n = dayNum(dtstartDate); n <= scanEnd; n++) {
    const d = fromDayNum(n);
    const y = +d.slice(0, 4);
    const m = +d.slice(5, 7);
    let ok: boolean;
    switch (rule.freq) {
      case "DAILY":
        ok = (n - dayNum(dtstartDate)) % rule.interval === 0;
        if (ok && rule.byDay.length) ok = rule.byDay.some((e) => e.wd === weekdayOf(d));
        if (ok && rule.byMonthDay.length) ok = matchesMonthDay(d, rule.byMonthDay);
        break;
      case "WEEKLY": {
        ok = (mondayWeek(d) - mondayWeek(dtstartDate)) % rule.interval === 0;
        const days = rule.byDay.length ? rule.byDay.map((e) => e.wd) : [startWd];
        if (ok) ok = days.includes(weekdayOf(d));
        break;
      }
      case "MONTHLY": {
        ok = ((y - startY) * 12 + (m - startM)) % rule.interval === 0;
        if (ok) {
          if (rule.byMonthDay.length) ok = matchesMonthDay(d, rule.byMonthDay);
          if (ok && rule.byDay.length) ok = rule.byDay.some((e) => matchesByDayInMonth(d, e));
          if (!rule.byMonthDay.length && !rule.byDay.length) ok = +d.slice(8, 10) === startD;
        }
        break;
      }
      case "YEARLY": {
        ok = (y - startY) % rule.interval === 0;
        const months = rule.byMonth.length ? rule.byMonth : [startM];
        if (ok) ok = months.includes(m);
        if (ok) {
          if (rule.byMonthDay.length) ok = matchesMonthDay(d, rule.byMonthDay);
          if (ok && rule.byDay.length) ok = rule.byDay.some((e) => matchesByDayInMonth(d, e));
          if (!rule.byMonthDay.length && !rule.byDay.length) ok = +d.slice(8, 10) === startD;
        }
        break;
      }
    }
    // A BYMONTH filter on a non-YEARLY rule narrows it too.
    if (ok && rule.freq !== "YEARLY" && rule.byMonth.length) ok = rule.byMonth.includes(m);
    // RFC 5545: DTSTART is always the first instance.
    if (n === dayNum(dtstartDate)) ok = true;
    if (!ok) continue;
    out.push(d);
    if (rule.count !== null && out.length >= rule.count) break;
  }
  return out;
}

// ---------------------------------------------------------------- mapping

const propOf = (c: IcsComponent, name: string): IcsProp | undefined =>
  c.props.find((p) => p.name === name);
const propsOf = (c: IcsComponent, name: string): IcsProp[] =>
  c.props.filter((p) => p.name === name);
const textOf = (c: IcsComponent, name: string): string | null => {
  const p = propOf(c, name);
  if (!p) return null;
  const s = unescapeText(p.value).trim();
  return s || null;
};

const US_STATE = /^[A-Za-z]{2}$/;
const ZIP = /^\d{5}(?:-\d{4})?$/;

/**
 * LOCATION free text → venue parts. Handles the common exporter shapes:
 *   "Name, 117 Museum St., Owls Head, ME, 04854, United States"  (TEC)
 *   "Name, 1 Main St, Town, ME 04001"                              (Google)
 *   "ME"                                                            (a bare state — kept as state only, so
 *                                                                    ingest's state-only-location rule fires)
 */
export function parseLocation(loc: string | null): FeedVenue | null {
  if (!loc) return null;
  const s = loc.trim();
  if (!s) return null;
  if (US_STATE.test(s))
    return { name: null, address: null, city: null, state: s.toUpperCase(), zip: null };
  let parts = s
    .split(/\s*,\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length && /^(united states(?: of america)?|usa|us)$/i.test(parts[parts.length - 1]))
    parts = parts.slice(0, -1);
  let zip: string | null = null;
  let state: string | null = null;
  if (parts.length && ZIP.test(parts[parts.length - 1])) {
    zip = parts[parts.length - 1];
    parts = parts.slice(0, -1);
  }
  if (parts.length) {
    const lastPart = parts[parts.length - 1];
    const sz = /^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/.exec(lastPart);
    if (sz) {
      state = sz[1].toUpperCase();
      zip = zip ?? sz[2] ?? null;
      parts = parts.slice(0, -1);
    }
  }
  if (!state) {
    // Not an address we can read — keep the whole text as the venue name.
    return { name: s, address: null, city: null, state: null, zip: null };
  }
  // What is left, in exporter order: [name?, street?, …, city].
  if (parts.length === 0) return { name: null, address: null, city: null, state, zip };
  if (parts.length === 1) return { name: null, address: null, city: parts[0], state, zip };
  const city = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  const startsWithNumber = /^\d/.test(rest[0]);
  return {
    name: startsWithNumber ? null : rest[0],
    address: (startsWithNumber ? rest : rest.slice(1)).join(", ") || null,
    city,
    state,
    zip,
  };
}

interface VeventInstance {
  externalId: string;
  start: LocalTime;
  end: LocalTime | null;
  allDay: boolean;
  tz: string | null;
  source: IcsComponent;
}

export interface IcsReadOptions {
  /** Local "YYYY-MM-DD": instances ending before this are not returned. */
  windowStart: string;
  /** Local "YYYY-MM-DD": instances starting after this are not returned. */
  windowEnd: string;
  /** Zone for UTC and floating values when the calendar names none. */
  defaultTz?: string;
  /** Hard cap on instances returned (a runaway RRULE cannot flood the ingest). */
  maxInstances?: number;
}

export interface IcsParseResult {
  events: FeedEvent[];
  calendarName: string | null;
  calendarTz: string | null;
  /** VEVENTs we could not use (no DTSTART, unparseable date). */
  skipped: number;
  /** Things we did not fully understand — reported, never silently guessed. */
  warnings: string[];
  /** True when maxInstances cut the list short. */
  truncated: boolean;
}

function toFeedEvent(inst: VeventInstance, defaultTz: string | null): FeedEvent {
  const c = inst.source;
  const rawDesc = textOf(c, "DESCRIPTION") ?? "";
  const description = (/<[a-z][\s\S]*>/i.test(rawDesc) ? htmlToText(rawDesc) : rawDesc)
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
  const status = (textOf(c, "STATUS") ?? "").toUpperCase();
  const organizer = propOf(c, "ORGANIZER");
  const orgEmail = organizer
    ? (/mailto:(.+)$/i.exec(organizer.value.trim())?.[1]?.trim().toLowerCase() ?? null)
    : null;
  const attach = propsOf(c, "ATTACH").find(
    (p) =>
      /^https?:\/\//i.test(p.value.trim()) &&
      (/^image\//i.test(p.params.FMTTYPE ?? "") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(p.value))
  );
  const categories = propsOf(c, "CATEGORIES")
    .flatMap((p) => unescapeText(p.value).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const seq = textOf(c, "SEQUENCE");
  const lastMod = propOf(c, "LAST-MODIFIED");
  const end = inst.end;
  return {
    externalId: inst.externalId,
    title: textOf(c, "SUMMARY") ?? "(untitled)",
    url: textOf(c, "URL"),
    startDate: inst.start.date,
    endDate: end ? end.date : inst.start.date,
    startTime: inst.allDay ? null : inst.start.time,
    endTime: inst.allDay ? null : (end?.time ?? null),
    allDay: inst.allDay,
    timezone: inst.tz ?? defaultTz,
    venue: parseLocation(textOf(c, "LOCATION")),
    organizerEmails: orgEmail ? [orgEmail] : [],
    imageUrl: attach ? attach.value.trim() : null,
    description,
    categories,
    cost: null,
    statusCancelled: status === "CANCELLED",
    sequence: seq !== null && /^\d+$/.test(seq) ? Number(seq) : null,
    lastModified: lastMod ? lastMod.value.trim() : null,
  };
}

/** Parse an iCalendar document into FeedEvents for a local date window. */
export function parseIcsFeed(text: string, opts: IcsReadOptions): IcsParseResult {
  const root = parseIcs(text);
  const cal = root.children.find((c) => c.type === "VCALENDAR") ?? root;
  const calName = textOf(cal, "X-WR-CALNAME");
  const calTz = resolveTzid(textOf(cal, "X-WR-TIMEZONE")) ?? opts.defaultTz ?? null;
  const maxInstances = opts.maxInstances ?? 1000;
  const warnings: string[] = [];
  let skipped = 0;

  // Group VEVENTs by UID: the master (no RECURRENCE-ID) and its overrides.
  const masters = new Map<string, IcsComponent>();
  const overrides = new Map<string, Map<string, IcsComponent>>();
  let anon = 0;
  for (const v of cal.children.filter((c) => c.type === "VEVENT")) {
    const uid = textOf(v, "UID") ?? `nouid-${++anon}`;
    const rid = propOf(v, "RECURRENCE-ID");
    if (rid) {
      const at = parseIcsDateValue(rid, calTz);
      if (!at) {
        skipped++;
        continue;
      }
      if (!overrides.has(uid)) overrides.set(uid, new Map());
      overrides.get(uid)!.set(at.date, v);
      continue;
    }
    const prior = masters.get(uid);
    if (prior) {
      const seq = (c: IcsComponent) => Number(textOf(c, "SEQUENCE") ?? 0) || 0;
      warnings.push(`UID ${uid} appears twice without RECURRENCE-ID; kept the higher SEQUENCE`);
      if (seq(v) < seq(prior)) continue;
    }
    masters.set(uid, v);
  }

  const instances: VeventInstance[] = [];
  const timing = (v: IcsComponent) => {
    const ds = propOf(v, "DTSTART");
    const start = ds ? parseIcsDateValue(ds, calTz) : null;
    if (!start) return null;
    const allDay = start.time === null;
    const de = propOf(v, "DTEND");
    let end: LocalTime | null = de ? parseIcsDateValue(de, calTz) : null;
    if (!end) {
      const dur = parseDurationMinutes(textOf(v, "DURATION"));
      if (dur !== null)
        end = allDay
          ? { date: addDays(start.date, Math.round(dur / 1440)), time: null }
          : fromMinutes(minutesOf(start) + dur);
    }
    // All-day DTEND is exclusive: a one-day event ends the day it starts.
    if (end && allDay)
      end = { date: end.date > start.date ? addDays(end.date, -1) : start.date, time: null };
    const durationMins = end ? minutesOf(end) - minutesOf(start) : null;
    return { start, end, allDay, durationMins };
  };

  for (const [uid, master] of masters) {
    const t = timing(master);
    if (!t) {
      skipped++;
      continue;
    }
    const rruleProp = propOf(master, "RRULE");
    if (!rruleProp) {
      instances.push({
        externalId: uid,
        start: t.start,
        end: t.end,
        allDay: t.allDay,
        tz: t.start.tz,
        source: master,
      });
      continue;
    }
    const rule = parseRrule(rruleProp.value, calTz);
    if (!rule) {
      warnings.push(
        `UID ${uid}: unreadable RRULE "${rruleProp.value}"; kept the first instance only`
      );
      instances.push({
        externalId: `${uid}::${t.start.date}`,
        start: t.start,
        end: t.end,
        allDay: t.allDay,
        tz: t.start.tz,
        source: master,
      });
      continue;
    }
    if (rule.unsupported.length)
      warnings.push(
        `UID ${uid}: RRULE parts not expanded (${rule.unsupported.join(", ")}); kept the first instance only`
      );
    const exdates = new Set(
      propsOf(master, "EXDATE").flatMap((p) =>
        p.value
          .split(",")
          .map((v) => parseIcsDateValue({ ...p, value: v }, calTz)?.date)
          .filter((d): d is string => !!d)
      )
    );
    const ovs = overrides.get(uid) ?? new Map<string, IcsComponent>();
    for (const date of expandRrule(t.start.date, rule, opts.windowEnd)) {
      if (exdates.has(date)) continue;
      const ov = ovs.get(date);
      if (ov) {
        const ot = timing(ov);
        if (ot) {
          instances.push({
            externalId: `${uid}::${date}`,
            start: ot.start,
            end: ot.end,
            allDay: ot.allDay,
            tz: ot.start.tz,
            source: {
              ...ov,
              props: [
                ...ov.props,
                ...master.props.filter((p) => !ov.props.some((q) => q.name === p.name)),
              ],
            },
          });
          continue;
        }
      }
      const start: LocalTime = { date, time: t.start.time };
      const end =
        t.durationMins === null
          ? null
          : t.allDay
            ? { date: addDays(date, Math.round(t.durationMins / 1440)), time: null }
            : fromMinutes(minutesOf(start) + t.durationMins);
      instances.push({
        externalId: `${uid}::${date}`,
        start,
        end,
        allDay: t.allDay,
        tz: t.start.tz,
        source: master,
      });
    }
    // An override whose date the rule never produced (a moved instance) still counts.
    for (const [date, ov] of ovs) {
      if (instances.some((i) => i.externalId === `${uid}::${date}`)) continue;
      const ot = timing(ov);
      if (ot)
        instances.push({
          externalId: `${uid}::${date}`,
          start: ot.start,
          end: ot.end,
          allDay: ot.allDay,
          tz: ot.start.tz,
          source: {
            ...ov,
            props: [
              ...ov.props,
              ...master.props.filter((p) => !ov.props.some((q) => q.name === p.name)),
            ],
          },
        });
    }
  }
  // Overrides whose master is absent (some exporters publish only the changed instance).
  for (const [uid, ovs] of overrides) {
    if (masters.has(uid)) continue;
    for (const [date, ov] of ovs) {
      const ot = timing(ov);
      if (ot)
        instances.push({
          externalId: `${uid}::${date}`,
          start: ot.start,
          end: ot.end,
          allDay: ot.allDay,
          tz: ot.start.tz,
          source: ov,
        });
      else skipped++;
    }
  }

  const inWindow = instances
    .filter(
      (i) => (i.end?.date ?? i.start.date) >= opts.windowStart && i.start.date <= opts.windowEnd
    )
    .sort((a, b) =>
      (a.start.date + (a.start.time ?? "")).localeCompare(b.start.date + (b.start.time ?? ""))
    );
  const truncated = inWindow.length > maxInstances;
  if (truncated)
    warnings.push(`${inWindow.length} instances in the window; returned the first ${maxInstances}`);
  return {
    events: inWindow.slice(0, maxInstances).map((i) => toFeedEvent(i, calTz)),
    calendarName: calName,
    calendarTz: calTz,
    skipped,
    warnings,
    truncated,
  };
}

/** `webcal://` is the subscribe scheme for an https calendar. */
export function normalizeCalendarUrl(url: string): string {
  return url.trim().replace(/^webcals?:\/\//i, "https://");
}

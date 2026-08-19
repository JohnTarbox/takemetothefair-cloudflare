/**
 * OPE-479 — read a published "Fair Hours" block into per-day hours.
 *
 * ## The defect
 *
 * `marthasvineyardagriculturalsociety.org/the-fair` publishes this, plainly
 * labelled:
 *
 *     Fair Hours
 *     Thursday, Friday and Saturday: 10 AM to 11 PM
 *     Hall opens in the afternoon and closes at 10 PM
 *     Barn closes at 9 PM
 *     Fiber Tent closes at 5 PM
 *     Sunday: 10 AM to 6 PM
 *     Hall, Barn, and Fiber Tent close at 5 PM
 *     Carnival Opens at 11 AM each day of the Fair
 *
 * None of it was captured. The APPROVED page read "Hours not listed — check
 * with organizer" on 2,053 views until someone typed it in by hand. Hours are
 * the single most-asked question about a fair, and `event_days` is a first-class
 * table — the extractor reached clearly-structured content and promoted none of
 * it.
 *
 * ## The distinction this file exists to make
 *
 * **Gate hours are the event's hours. Building hours are notes.**
 *
 * `Barn closes at 9 PM` is not the fair closing at 9 PM, and writing it into
 * `close_time` would publish a wrong closing time that looks measured. So a line
 * naming a specific attraction — Hall, Barn, Fiber Tent, carnival — attaches to
 * the preceding day group as a note and never touches open/close.
 *
 * That asymmetry is the whole reason this is a parser and not a regex: the two
 * kinds of line look nearly identical and mean completely different things.
 *
 * ## What it will not do
 *
 * Guess. A day the organizer did not publish gets no hours — and, per the MDI
 * incident (a plausible descending 10-5/10-4/10-3 invented against a published
 * flat 9-4), a plausible pattern is exactly the dangerous output here. Nothing
 * is interpolated across days and nothing is carried between editions.
 */

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tues: 2,
  tue: 2,
  wednesday: 3,
  weds: 3,
  wed: 3,
  thursday: 4,
  thurs: 4,
  thur: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join("|");

/**
 * Attractions inside a fair, whose times are NOT the gate's.
 *
 * Deliberately a list of things rather than a pattern: "closes at 9 PM" is
 * indistinguishable from the fair closing at 9 PM without knowing that "Barn"
 * names a building.
 */
const ATTRACTION_WORDS = [
  "hall",
  "barn",
  "tent",
  "carnival",
  "midway",
  "grandstand",
  "exhibit",
  "arena",
  "museum",
  "pavilion",
  "stage",
  "rides",
  "office",
  "gate",
];

export interface DayHours {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** "HH:MM" 24-hour wall clock at the venue, or null when only a close is given. */
  openTime: string | null;
  closeTime: string | null;
  /** Building/attraction lines that apply to this day, verbatim. */
  notes: string[];
}

/** `10 AM` / `6:30pm` / `11 P.M.` → "HH:MM". Returns null when unparseable. */
export function parseClockTime(raw: string): string | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(raw);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const isPm = m[3].toLowerCase() === "p";
  if (hour === 12) hour = 0;
  if (isPm) hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Every weekday named at the start of a line, e.g. "Thursday, Friday and Saturday:". */
function leadingWeekdays(line: string): number[] {
  const head = line.split(":")[0];
  const found: number[] = [];
  for (const m of head.matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, "gi"))) {
    const d = WEEKDAYS[m[1].toLowerCase()];
    if (!found.includes(d)) found.push(d);
  }
  return found;
}

/** True when the line is about a building or attraction rather than the fair. */
function isAttractionLine(line: string): boolean {
  const lower = line.toLowerCase();
  return ATTRACTION_WORDS.some((w) => new RegExp(`\\b${w}s?\\b`).test(lower));
}

/** True when a note applies to the whole run ("each day of the Fair"). */
function isEveryDayLine(line: string): boolean {
  return /\b(each|every)\s+day\b|\ball\s+days\b|\bdaily\b/i.test(line);
}

/**
 * Parse a published hours block into per-day hours.
 *
 * Returns [] when the text carries no recognisable day-scoped hours — an empty
 * result means "nothing published here", never "assume the usual".
 */
export function parseHoursBlock(text: string | null | undefined): DayHours[] {
  if (!text) return [];

  const byWeekday = new Map<number, DayHours>();
  // Days named by the most recent hours line, so a following attraction line
  // knows which day(s) it qualifies.
  let currentGroup: number[] = [];
  const everyDayNotes: string[] = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // An attraction line applies to days already established — or, when it says
    // so, to every day. Checked BEFORE the weekday scan, because
    // "Hall, Barn, and Fiber Tent close at 5 PM" contains no weekday but
    // "Carnival Opens at 11 AM each day" would otherwise be read as a schedule.
    if (isAttractionLine(line)) {
      if (isEveryDayLine(line)) everyDayNotes.push(line);
      else for (const d of currentGroup) byWeekday.get(d)?.notes.push(line);
      continue;
    }

    const days = leadingWeekdays(line);
    if (days.length === 0) continue;

    // "10 AM to 11 PM" — take the first two clock times on the line.
    const times = [...line.matchAll(/\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\.?/gi)]
      .map((m) => parseClockTime(m[0]))
      .filter((t): t is string => t !== null);

    const openTime = times[0] ?? null;
    const closeTime = times[1] ?? null;
    if (!openTime && !closeTime) continue;

    currentGroup = days;
    for (const d of days) {
      // A later line for the same weekday wins; organizers restate rather than
      // contradict, and the restatement is usually the correction.
      byWeekday.set(d, { weekday: d, openTime, closeTime, notes: [] });
    }
  }

  if (byWeekday.size === 0) return [];

  for (const day of byWeekday.values()) day.notes.push(...everyDayNotes);

  return [...byWeekday.values()].sort((a, b) => a.weekday - b.weekday);
}

/**
 * Map parsed per-day hours onto the actual dates an event runs.
 *
 * A published block names weekdays; `event_days` needs dates. Days in the run
 * with no published hours are returned with nulls rather than filled in from a
 * neighbour — see the MDI note in the header.
 */
export interface DatedDayHours extends DayHours {
  /** ISO `YYYY-MM-DD`. */
  date: string;
}

export function applyHoursToDates(
  hours: ReadonlyArray<DayHours>,
  startDate: string,
  endDate: string
): DatedDayHours[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  if (end < start) return [];

  const byWeekday = new Map(hours.map((h) => [h.weekday, h]));
  const out: DatedDayHours[] = [];

  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    const match = byWeekday.get(d.getUTCDay());
    if (!match) continue; // no published hours for this day — leave it out
    out.push({ ...match, date: d.toISOString().slice(0, 10) });
  }

  return out;
}

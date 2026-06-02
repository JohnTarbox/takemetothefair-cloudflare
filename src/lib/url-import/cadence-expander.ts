/**
 * Cadence expander — deterministic backstop for recurring/multi-date events.
 *
 * The AI extractor is supposed to enumerate occurrences into `specificDates`
 * when a source describes a cadence ("every other Saturday"), but the LLM
 * sometimes returns only the season's start/end dates instead. This helper
 * fills the gap: given a body of text and an inclusive date window, it
 * detects common cadence phrases and produces a sorted list of YYYY-MM-DD
 * occurrence dates.
 *
 * Patterns supported (added in order of frequency in real submissions):
 *   1. "every other <weekday>"           → biweekly from the first occurrence
 *   2. "every <weekday>" / "weekly"      → weekly cadence
 *   3. "<Nth> <weekday> of [the|every|each] month"  → monthly pattern (N=1..4|last)
 *   4. Explicit lists                    → "May 23, June 6, June 20" or "5/23, 6/6, 6/20"
 *   5. "every <weekday> and <weekday>"   → multi-weekday weekly (PR-7, 2026-06-01)
 *      "<weekday>s and <weekday>s"       → same, pluralized form
 *      Two separate weekly cadences fired in one sweep. The pluralized form
 *      ("Saturdays and Sundays") and the `every` prefix are intentional
 *      anchors: they signal recurrence rather than scope ("Closed Saturday
 *      and Sunday"). Singular-without-every ("Tuesday and Thursday" alone)
 *      stays out of scope — too easily confused with closure / hours
 *      statements; let those flag for human review.
 *
 * Out of scope (rare enough to defer): "monthly on the 15th",
 * "the second and fourth Wednesday", singular-without-every multi-weekday.
 *
 * Failure mode: returns an empty array when no pattern matches or the
 * window is invalid. Caller falls back to whatever the AI produced (or to
 * a single-date event).
 */

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const ORDINALS: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  last: -1,
};

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export interface CadenceExpandOptions {
  /** Inclusive start of the window. YYYY-MM-DD. */
  windowStart: string;
  /** Inclusive end of the window. YYYY-MM-DD. */
  windowEnd: string;
}

/**
 * Detect cadence phrases in `text` and enumerate concrete occurrence dates
 * within the [windowStart, windowEnd] window (inclusive). Returns a sorted,
 * deduped array of YYYY-MM-DD strings. Returns [] when no pattern matches
 * or the window is invalid.
 */
export function expandCadence(text: string, opts: CadenceExpandOptions): string[] {
  if (!text) return [];
  const start = parseYmd(opts.windowStart);
  const end = parseYmd(opts.windowEnd);
  if (!start || !end || start > end) return [];

  const normalized = text.toLowerCase();
  const dates = new Set<string>();

  for (const d of detectExplicitList(text, opts.windowStart, opts.windowEnd)) {
    dates.add(d);
  }

  // "every other <weekday>" — biweekly. Needs an anchor; pick the first
  // occurrence inside the window.
  const everyOther = /every\s+other\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i;
  const everyOtherMatch = normalized.match(everyOther);
  if (everyOtherMatch) {
    const dow = WEEKDAYS[everyOtherMatch[1].toLowerCase()];
    enumerateInterval(start, end, dow, 14, dates);
  }

  // Multi-weekday weekly (PR-7, 2026-06-01). Two anchored forms:
  //   - "every <weekday> and <weekday>"  → explicit recurrence intent
  //   - "<weekday>s and <weekday>s"      → pluralized form ("Saturdays and Sundays")
  // Both fire enumerateInterval(7) for each weekday so the Set ends up with
  // BOTH days' occurrences. Without this rule, the single-weekday regex
  // below would silently match only the FIRST weekday and produce
  // half the data — worse than no data per the multi-weekday hazard
  // ([[feedback_silent_empty_array_failures]] family). Result: two
  // dedup-by-date weekly streams in the Set.
  const multiWeeklyEvery =
    /every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:and|&)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
  const multiWeeklyPlural =
    /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\s+(?:and|&)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b/i;
  const multiMatch = normalized.match(multiWeeklyEvery) ?? normalized.match(multiWeeklyPlural);
  if (multiMatch && !everyOtherMatch) {
    const dow1 = WEEKDAYS[multiMatch[1].toLowerCase()];
    const dow2 = WEEKDAYS[multiMatch[2].toLowerCase()];
    enumerateInterval(start, end, dow1, 7, dates);
    enumerateInterval(start, end, dow2, 7, dates);
  }

  // "every <weekday>" (weekly) — only fire if we didn't already match
  // "every other …" (since "every other Saturday" also matches /every saturday/).
  // Note: the multi-weekday rule above may also have fired; if so, this
  // singleton match for "every <weekday>" re-adds the first weekday's
  // dates, deduped by the Set. No correctness impact.
  if (!everyOtherMatch) {
    const everyWeekly = /every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
    const m = normalized.match(everyWeekly);
    if (m) {
      const dow = WEEKDAYS[m[1].toLowerCase()];
      enumerateInterval(start, end, dow, 7, dates);
    }
  }

  // "<Nth> <weekday> of [the|every|each] month" — monthly.
  const monthlyRe =
    /\b(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+of\s+(?:the|every|each)\s+month/i;
  const monthlyMatch = normalized.match(monthlyRe);
  if (monthlyMatch) {
    const n = ORDINALS[monthlyMatch[1].toLowerCase()];
    const dow = WEEKDAYS[monthlyMatch[2].toLowerCase()];
    enumerateMonthly(start, end, n, dow, dates);
  }

  return Array.from(dates).sort();
}

/* ─── internals ──────────────────────────────────────────────────────── */

function parseYmd(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(dt.getTime())) return null;
  // Round-trip check rejects nonsensical days like 2026-02-31
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Walk the window in `intervalDays` steps from the first occurrence of
 * `dow` on/after `start`, emitting one date per step until past `end`.
 */
function enumerateInterval(
  start: Date,
  end: Date,
  dow: number,
  intervalDays: number,
  out: Set<string>
): void {
  const first = new Date(start);
  const shift = (dow - first.getUTCDay() + 7) % 7;
  first.setUTCDate(first.getUTCDate() + shift);
  for (const d = new Date(first); d <= end; d.setUTCDate(d.getUTCDate() + intervalDays)) {
    out.add(formatYmd(d));
  }
}

/**
 * Walk month by month. For each month overlapping the window, emit the Nth
 * occurrence of `dow` (N=1..4 = first..fourth, N=-1 = last) if it falls
 * inside the window.
 */
function enumerateMonthly(start: Date, end: Date, n: number, dow: number, out: Set<string>): void {
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= endMonth) {
    const occ = nthWeekdayOfMonth(cursor.getUTCFullYear(), cursor.getUTCMonth(), n, dow);
    if (occ && occ >= start && occ <= end) {
      out.add(formatYmd(occ));
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}

function nthWeekdayOfMonth(year: number, month: number, n: number, dow: number): Date | null {
  if (n === -1) {
    // Last occurrence: walk backward from the last day of the month.
    const last = new Date(Date.UTC(year, month + 1, 0));
    const shift = (last.getUTCDay() - dow + 7) % 7;
    last.setUTCDate(last.getUTCDate() - shift);
    return last;
  }
  // First occurrence on/after the 1st, then add (n-1) weeks.
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (dow - first.getUTCDay() + 7) % 7;
  first.setUTCDate(first.getUTCDate() + shift + (n - 1) * 7);
  if (first.getUTCMonth() !== month) return null; // e.g. 5th Friday in a month that has only 4
  return first;
}

/**
 * Detect explicit date lists in text. Only emits if ≥3 distinct dates are
 * found in a single 200-char window (a single date isn't a "list"). Supports
 * "Month Day" ("May 23"), "M/D/YY", and "M/D/YYYY" formats.
 */
function detectExplicitList(text: string, windowStart: string, windowEnd: string): string[] {
  const start = parseYmd(windowStart);
  const end = parseYmd(windowEnd);
  if (!start || !end) return [];

  // Use the window-start year as the inferred year for bare "Month Day"
  // strings. If the explicit dates span a year boundary the AI/JSON-LD
  // path already disambiguates; this helper is a backstop, not primary.
  const inferredYear = start.getUTCFullYear();

  const candidates: Array<{ pos: number; date: string }> = [];

  // "Month Day" pattern — "May 23" or "May 23, 2026"
  const monthDayRe = new RegExp(
    `\\b(${MONTH_NAMES.join("|")})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?`,
    "gi"
  );
  for (const m of text.matchAll(monthDayRe)) {
    const monthIdx = MONTH_NAMES.indexOf(m[1].toLowerCase());
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : inferredYear;
    const d = new Date(Date.UTC(year, monthIdx, day));
    if (d.getUTCMonth() === monthIdx && d.getUTCDate() === day && d >= start && d <= end) {
      candidates.push({ pos: m.index ?? 0, date: formatYmd(d) });
    }
  }

  // "M/D/YY" or "M/D/YYYY" pattern
  const slashRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  for (const m of text.matchAll(slashRe)) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = m[3] ? parseInt(m[3], 10) : inferredYear;
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() === month - 1 && d.getUTCDate() === day && d >= start && d <= end) {
      candidates.push({ pos: m.index ?? 0, date: formatYmd(d) });
    }
  }

  if (candidates.length < 3) return [];

  // Cluster candidates by proximity (200-char window) — a single dense
  // cluster of ≥3 dates is the signal we want; isolated dates scattered
  // across an article aren't a "list" and shouldn't expand.
  candidates.sort((a, b) => a.pos - b.pos);
  const out = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    let clusterCount = 1;
    let j = i + 1;
    while (j < candidates.length && candidates[j].pos - candidates[i].pos <= 200) {
      clusterCount++;
      j++;
    }
    if (clusterCount >= 3) {
      for (let k = i; k < j; k++) out.add(candidates[k].date);
    }
  }
  return Array.from(out);
}

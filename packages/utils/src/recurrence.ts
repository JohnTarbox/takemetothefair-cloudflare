/**
 * Recurrence-rule parsing + next-occurrence date math. Shared between the main
 * app and the MCP server (the K27 auto-rollover lives in mcp-server, but the
 * parser is generic and the main app may want it for display).
 *
 * Scope: a deliberately small subset of RFC 5545 RRULE. We only need FREQ and
 * INTERVAL to compute the NEXT occurrence of a recurring event — BYDAY / UNTIL /
 * COUNT and friends are parsed-around (ignored) rather than honored. The point
 * is to advance an event's start/end by one cadence period (e.g. an annual fair
 * 2026 → 2027), not to expand a full occurrence set.
 *
 * Rule-string format note: the stored `events.recurrence_rule` value is the
 * FULL RFC 5545 form `FREQ=YEARLY;INTERVAL=1`, because the ICS consumer
 * (src/lib/utils.ts generateICSContent) emits `RRULE:${recurrence_rule}`
 * verbatim — a bare `YEARLY;INTERVAL=1` would produce an invalid VEVENT. The
 * parser below is tolerant of BOTH the canonical `FREQ=`-prefixed form and the
 * bare form, so hand-seeded values don't silently fail to match.
 */

import { normalizeEventDate } from "./event-dates";

export type RecurrenceFreq = "YEARLY" | "MONTHLY" | "WEEKLY" | "DAILY";

const KNOWN_FREQS: readonly RecurrenceFreq[] = ["YEARLY", "MONTHLY", "WEEKLY", "DAILY"];

export interface ParsedRecurrence {
  freq: RecurrenceFreq;
  /** Period multiplier. `>= 1`. Defaults to 1 when absent or unparseable. */
  interval: number;
}

/**
 * Parse a recurrence-rule string into `{ freq, interval }`, or `null` when no
 * known FREQ can be found.
 *
 * Tolerant of:
 *   - canonical `FREQ=YEARLY;INTERVAL=2`
 *   - bare `YEARLY;INTERVAL=2` (FREQ keyword omitted)
 *   - frequency-only `MONTHLY` (interval defaults to 1)
 *   - lower-case, surrounding whitespace, and unrelated RRULE parts
 *     (`BYDAY`, `UNTIL`, …) which are ignored.
 *
 * Returns `null` for empty/unknown input so callers can treat "no parseable
 * cadence" as "do not roll".
 */
export function parseRecurrenceRule(rule: string | null | undefined): ParsedRecurrence | null {
  if (!rule) return null;
  const parts = rule
    .toUpperCase()
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

  let freq: RecurrenceFreq | null = null;
  let interval = 1;

  for (const part of parts) {
    if (part.includes("=")) {
      const [rawKey, rawVal] = part.split("=", 2);
      const key = rawKey.trim();
      const val = (rawVal ?? "").trim();
      if (key === "FREQ") {
        if ((KNOWN_FREQS as readonly string[]).includes(val)) {
          freq = val as RecurrenceFreq;
        }
      } else if (key === "INTERVAL") {
        const n = Number.parseInt(val, 10);
        if (Number.isFinite(n) && n >= 1) interval = n;
      }
      continue;
    }
    // Bare token — treat a standalone known frequency word as the FREQ.
    if (!freq && (KNOWN_FREQS as readonly string[]).includes(part)) {
      freq = part as RecurrenceFreq;
    }
  }

  if (!freq) return null;
  return { freq, interval };
}

function daysInMonthUTC(year: number, monthIndex: number): number {
  // Day 0 of the *next* month is the last day of `monthIndex`.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Advance a date by `addMonths` whole months in UTC, clamping the day-of-month
 * so we never roll past the target month. Preserves the source time-of-day.
 *
 * Without the clamp, JS `setUTCMonth` auto-rolls overflow (Jan-31 + 1mo →
 * Mar-3); we want Jan-31 → Feb-28/29 and leap Feb-29 + 12mo → Feb-28.
 */
function advanceWholeMonths(date: Date, addMonths: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  const totalMonths = d.getUTCFullYear() * 12 + d.getUTCMonth() + addMonths;
  const year = Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonthUTC(year, month));
  // setUTCFullYear(y, m, d) sets all three atomically (no intermediate
  // overflow) while leaving hours/minutes/seconds untouched.
  d.setUTCFullYear(year, month, clampedDay);
  return d;
}

function addDaysUTC(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Advance a single date by exactly one cadence period (`freq` × `interval`),
 * in UTC, then re-anchor to the project's noon-UTC convention via
 * `normalizeEventDate` (a no-op unless the source happened to sit at exact
 * midnight UTC).
 */
export function advanceDateUTC(date: Date, freq: RecurrenceFreq, interval: number): Date {
  const step = interval >= 1 ? interval : 1;
  let result: Date;
  switch (freq) {
    case "YEARLY":
      result = advanceWholeMonths(date, 12 * step);
      break;
    case "MONTHLY":
      result = advanceWholeMonths(date, step);
      break;
    case "WEEKLY":
      result = addDaysUTC(date, 7 * step);
      break;
    case "DAILY":
      result = addDaysUTC(date, step);
      break;
  }
  return normalizeEventDate(result) ?? result;
}

/**
 * Compute the next occurrence's start/end by advancing BOTH endpoints by one
 * cadence period. Advancing both (rather than recomputing end = start + span)
 * preserves the original span correctly across leap years and month-length
 * differences. Returns `null` when the rule is unparseable or either endpoint
 * is missing.
 */
export function computeNextOccurrence(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
  rule: string | null | undefined
): { start: Date; end: Date } | null {
  if (!startDate || !endDate) return null;
  const parsed = parseRecurrenceRule(rule);
  if (!parsed) return null;
  return {
    start: advanceDateUTC(startDate, parsed.freq, parsed.interval),
    end: advanceDateUTC(endDate, parsed.freq, parsed.interval),
  };
}

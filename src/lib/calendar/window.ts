// CAL1 — visible-month resolution for the SSR Month calendar.
//
// The `cal` search param ("YYYY-MM") is the source of truth for which month the
// calendar shows; absent/invalid → the current UTC month. We hand the module a
// mid-month anchor (DayKey) so the displayed month is unambiguous regardless of how
// the grid leads/trails into adjacent months.

import { todayIsoUtc } from "@takemetothefair/datetime";

export interface CalMonth {
  /** Full year, e.g. 2026. */
  year: number;
  /** 1–12. */
  month: number;
}

const CAL_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parse the `cal` param to a {year, month}; default = current UTC month. */
export function parseCalMonth(cal: string | undefined): CalMonth {
  const ym = cal && CAL_RE.test(cal) ? cal : todayIsoUtc().slice(0, 7);
  return { year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)) };
}

/** Mid-month DayKey ("YYYY-MM-15") — a stable anchor inside the target month. */
export function monthAnchorIso({ year, month }: CalMonth): string {
  return `${year}-${String(month).padStart(2, "0")}-15`;
}

/** "YYYY-MM" form, e.g. for building the next `cal` value from a navigation anchor. */
export function calMonthParam({ year, month }: CalMonth): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

const YEAR_RE = /^\d{4}$/;
/** Sane bounds so a hostile `cal_year` can't drive an absurd year of presence work. */
const MIN_CAL_YEAR = 2000;
const MAX_CAL_YEAR = 2100;

/**
 * CAL2 — parse the `cal_year` param ("YYYY") for the Year view; default = current
 * UTC year. Out-of-range or malformed values fall back to the current year (never
 * throw), mirroring how `parseCalMonth` degrades.
 */
export function parseCalYear(calYear: string | undefined): number {
  const current = Number(todayIsoUtc().slice(0, 4));
  if (!calYear || !YEAR_RE.test(calYear)) return current;
  const y = Number(calYear);
  return y >= MIN_CAL_YEAR && y <= MAX_CAL_YEAR ? y : current;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * CAL2 — parse the `cal_date` param ("YYYY-MM-DD"), the anchor for the Week/Day/
 * Custom time-grid views. Absent/malformed → today (UTC). Used as a `DayKey`.
 */
export function parseCalDate(calDate: string | undefined): string {
  return calDate && DATE_RE.test(calDate) ? calDate : todayIsoUtc();
}

/**
 * CAL2 — parse the `cal_days` param for the Custom time-grid view: an integer
 * 2–7 (the module's supported range). Absent/out-of-range → 3.
 */
export function parseCalDays(calDays: string | undefined): number {
  const n = Number(calDays);
  return Number.isInteger(n) && n >= 2 && n <= 7 ? n : 3;
}

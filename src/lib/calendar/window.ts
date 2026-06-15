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

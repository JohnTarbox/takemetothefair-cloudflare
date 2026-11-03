// OPE-1488 — ONE "focus date" for every calendar view, carried in the URL.
//
// Before this, each view kept its own anchor param (`cal` for Month, `cal_year` for
// Year, `cal_date` for Week/Day) and switching views dropped the others, so Month →
// Day landed on today, and a specific day could not be linked (`&date=` was ignored).
// Now `date=YYYY-MM-DD` is the focus date for every view and is written by every
// navigation; `cal` / `cal_year` are kept in step so existing `cal_view=` links (and
// the server's month/year anchors) keep working. The legacy `cal_date` is still read.
//
// "Today" is the America/New_York calendar date, not UTC (OPE-482): at 9pm Eastern on
// a Saturday, UTC is already Sunday, and the default week used to start a day late.

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

/** Today's America/New_York calendar date, "YYYY-MM-DD". */
export function todayEasternIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** A real calendar date (rejects 2026-02-30), or null. */
export function validIsoDate(s: string | undefined | null): string | null {
  if (!s || !DATE_RE.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return d.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * The day to focus when entering a month: today if today is in it, else the 1st.
 * `month` is "YYYY-MM".
 */
export function focusForMonth(month: string, today: string): string {
  return today.slice(0, 7) === month ? today : `${month}-01`;
}

/** Same rule for a year: today if this is the current year, else Jan 1. */
export function focusForYear(year: number, today: string): string {
  return Number(today.slice(0, 4)) === year ? today : `${year}-01-01`;
}

/**
 * Resolve the focus date from the URL, most specific first:
 * `date` → legacy `cal_date` → the month in `cal` → the year in `cal_year` → today.
 */
export function resolveFocusDate(
  params: { date?: string; cal_date?: string; cal?: string; cal_year?: string },
  today: string
): string {
  const explicit = validIsoDate(params.date) ?? validIsoDate(params.cal_date);
  if (explicit) return explicit;
  if (params.cal && MONTH_RE.test(params.cal)) return focusForMonth(params.cal, today);
  if (params.cal_year && YEAR_RE.test(params.cal_year)) {
    return focusForYear(Number(params.cal_year), today);
  }
  return today;
}

/**
 * Write the focus date (and a view) into a copy of the current params. Keeps `cal`
 * and `cal_year` consistent with it, drops the legacy `cal_date`, and resets paging.
 * Every other active filter (category, `days=`, …) is preserved.
 */
export function withFocus(
  current: URLSearchParams | Record<string, string | undefined>,
  focus: string,
  calView?: string
): URLSearchParams {
  // Next's ReadonlyURLSearchParams is a URLSearchParams subclass; duck-type it anyway.
  const p =
    typeof (current as URLSearchParams).getAll === "function"
      ? new URLSearchParams((current as URLSearchParams).toString())
      : new URLSearchParams(
          Object.entries(current as Record<string, string | undefined>).filter(
            (e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""
          )
        );
  p.set("view", "calendar");
  if (calView) p.set("cal_view", calView);
  p.set("date", focus);
  p.set("cal", focus.slice(0, 7));
  p.set("cal_year", focus.slice(0, 4));
  p.delete("cal_date");
  p.delete("page");
  return p;
}

/** `/events?…` href for the Day view of `date`, preserving filters. */
export function dayViewHref(
  current: URLSearchParams | Record<string, string | undefined>,
  date: string
): string {
  return `/events?${withFocus(current, date, "day").toString()}`;
}

/** "Tuesday, October 20, 2026" — for aria-labels. Formatted at noon UTC so no zone can shift the day. */
export function longDateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

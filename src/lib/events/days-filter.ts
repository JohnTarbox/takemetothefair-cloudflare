/**
 * OPE-1487 — the "Days" filter on /events (`?days=`).
 *
 * Four readings, because John ruled (2026-10-17) that "weekdays" means two
 * different questions and a visitor should get to ask either:
 *
 *   weekday-only  every public open day of the occurrence is Mon–Fri
 *   weekday-any   at least one public open day is Mon–Fri ("can I go on a weekday?")
 *   weekend-only  every public open day is Sat/Sun
 *   weekend-any   at least one public open day is Sat/Sun
 *
 * ── Which days count ────────────────────────────────────────────────────────
 * An event row is one occurrence (a recurring series has one row per edition),
 * so each row is judged on its own days:
 *
 *   - It has `event_days` rows → its non-closed, non-vendor-only days. Same
 *     "has any rows → use them" switch as OPE-48's `hasOccurrenceInWindowOrUndated`.
 *   - It has none → every calendar day from `start_date` to `end_date`.
 *
 * In the upcoming listing (`clipFrom` set) only days from today onward count, so
 * a Wed–Sun fair already into its Saturday no longer answers "yes" to "open on a
 * weekday?". With `includePast` every day counts.
 *
 * An occurrence with no usable date, or no public day left, matches none of the
 * four. The ticket says such events are excluded whenever a filter is set.
 *
 * ── Eastern calendar, not UTC ───────────────────────────────────────────────
 * `event_days.date` is already a local "YYYY-MM-DD", so its weekday is read
 * directly. `start_date` / `end_date` are UTC epoch SECONDS. Most are the
 * canonical noon-UTC anchor, which is the same calendar day everywhere, but an
 * imported 7pm-Friday-Eastern start is stored as Saturday 23:00Z and must not
 * become a Saturday. `easternDateSql` converts with the real US DST rule
 * (second Sunday of March 07:00Z → first Sunday of November 06:00Z is EDT,
 * UTC−4; otherwise EST, UTC−5) inside SQLite. Everything stays in SQL, so the
 * filter adds a fixed handful of bound parameters and composes with paging
 * (no post-filter, no `inArray` of ids — the D1 100-parameter cap).
 */
import { sql, type SQL } from "drizzle-orm";
import { events, eventDays } from "@/lib/db/schema";

export const DAYS_FILTERS = ["weekday-only", "weekday-any", "weekend-only", "weekend-any"] as const;
export type DaysFilter = (typeof DAYS_FILTERS)[number];

/** Visitor-facing labels. The "only" / "open on" wording is the distinction John asked to keep plain. */
export const DAYS_FILTER_LABELS: Record<DaysFilter, string> = {
  "weekday-only": "Weekdays only (Mon–Fri, no weekend days)",
  "weekday-any": "Open on a weekday (at least one Mon–Fri day)",
  "weekend-only": "Weekends only (Sat & Sun, no weekdays)",
  "weekend-any": "Open on a weekend (at least one Sat or Sun)",
};

/** Short labels for the active-filter pill. */
export const DAYS_FILTER_SHORT_LABELS: Record<DaysFilter, string> = {
  "weekday-only": "Weekdays only",
  "weekday-any": "Open on a weekday",
  "weekend-only": "Weekends only",
  "weekend-any": "Open on a weekend",
};

export function parseDaysFilter(value: string | undefined | null): DaysFilter | null {
  return (DAYS_FILTERS as readonly string[]).includes(value ?? "") ? (value as DaysFilter) : null;
}

/** Today's America/New_York calendar date as "YYYY-MM-DD". */
export function easternDateStr(d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * The America/New_York calendar date ("YYYY-MM-DD") of a UTC epoch-seconds
 * column, as SQL. NULL in → NULL out.
 */
export function easternDateSql(col: SQL | typeof events.startDate): SQL {
  const year = sql`strftime('%Y', ${col}, 'unixepoch')`;
  // date(…, 'weekday 0') moves to the next Sunday on or after the date.
  const dstStart = sql`(unixepoch(date(${year} || '-03-01', 'weekday 0', '+7 days')) + 25200)`;
  const dstEnd = sql`(unixepoch(date(${year} || '-11-01', 'weekday 0')) + 21600)`;
  return sql`date(${col} - (CASE WHEN ${col} >= ${dstStart} AND ${col} < ${dstEnd} THEN 14400 ELSE 18000 END), 'unixepoch')`;
}

/**
 * WHERE-clause predicate for a Days filter. `clipFrom` is today's Eastern date
 * for the upcoming listing, or null to judge every day (includePast).
 */
export function daysFilterPredicate(filter: DaysFilter, clipFrom: string | null): SQL {
  const weekend = filter.startsWith("weekend");
  const only = filter.endsWith("-only");

  // ── event_days branch ──
  const dayIsPublic = sql`COALESCE(${eventDays.closed}, 0) = 0 AND COALESCE(${eventDays.vendorOnly}, 0) = 0`;
  const dayInRange = clipFrom ? sql` AND ${eventDays.date} >= ${clipFrom}` : sql``;
  const dowIsWeekend = sql`CAST(strftime('%w', ${eventDays.date}) AS INTEGER) IN (0, 6)`;
  const publicDay = (extra: SQL) => sql`EXISTS (
      SELECT 1 FROM ${eventDays}
      WHERE ${eventDays.eventId} = ${events.id} AND ${dayIsPublic}${dayInRange}${extra}
    )`;
  const hasDayOfKind = publicDay(
    weekend ? sql` AND ${dowIsWeekend}` : sql` AND NOT ${dowIsWeekend}`
  );
  const hasDayOfOtherKind = publicDay(
    weekend ? sql` AND NOT ${dowIsWeekend}` : sql` AND ${dowIsWeekend}`
  );
  const daysBranch = only
    ? sql`(${hasDayOfKind} AND NOT ${hasDayOfOtherKind})`
    : sql`${hasDayOfKind}`;

  // ── start/end span branch (no event_days rows) ──
  const startE = easternDateSql(events.startDate);
  const endE = easternDateSql(sql`COALESCE(${events.endDate}, ${events.startDate})`);
  // Dates are "YYYY-MM-DD", so MAX() on the strings is MAX() on the dates.
  const spanStart = clipFrom ? sql`MAX(${startE}, ${clipFrom})` : startE;
  // n = number of calendar days in the span; w = weekday of its first day (0 = Sun).
  const n = sql`(CAST(julianday(${endE}) - julianday(${spanStart}) AS INTEGER) + 1)`;
  const w = sql`CAST(strftime('%w', ${spanStart}) AS INTEGER)`;
  // Saturday is (6 − w) mod 7 days in, Sunday (7 − w) mod 7; inside the span if < n.
  const spanHasWeekend = sql`(((6 - ${w} + 7) % 7) < ${n} OR ((7 - ${w}) % 7) < ${n})`;
  // Every day is a weekend day only for a lone Sat or Sun, or a Sat–Sun pair.
  const spanAllWeekend = sql`((${n} = 1 AND ${w} IN (0, 6)) OR (${n} = 2 AND ${w} = 6))`;
  const spanHasWeekday = sql`NOT ${spanAllWeekend}`;
  const spanMatch = weekend
    ? only
      ? spanAllWeekend
      : spanHasWeekend
    : only
      ? sql`NOT ${spanHasWeekend}`
      : spanHasWeekday;
  const spanBranch = sql`(${events.startDate} IS NOT NULL AND ${n} >= 1 AND ${spanMatch})`;

  return sql`(
    CASE WHEN EXISTS (SELECT 1 FROM ${eventDays} WHERE ${eventDays.eventId} = ${events.id})
      THEN ${daysBranch}
      ELSE ${spanBranch}
    END
  )`;
}

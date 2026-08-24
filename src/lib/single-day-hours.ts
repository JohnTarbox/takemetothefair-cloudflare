/**
 * OPE-531 — where a one-day event's hours are allowed to live.
 *
 * `events` has no time columns. Hours exist only as `event_days` rows, and
 * `/api/suggest-event/submit` built those rows from `eventDays` or
 * `specificDates` and from nothing else. `data.startTime` / `data.endTime`
 * were read only inside the `specificDates` branch, so a submission for a
 * single-day event carrying "10 AM-3 PM" had its hours extracted correctly
 * and then dropped on the floor at the write.
 *
 * Live specimen: inbound `a0e400a9` ("VCS Makers Market") states its hours
 * twice in the body; event `c8648f70` has no `event_days` row at all.
 *
 * Extracted as a pure function rather than inlined so it can be tested
 * against the real implementation — the route itself needs D1, auth and a
 * live venue matcher, and a test that re-implements the rule pins a copy
 * rather than the shipped code.
 */

export interface SingleDayHoursInput {
  /** Noon-UTC-anchored start, as produced by `normalizeEventDate`. */
  startDate: Date | null;
  /** Noon-UTC-anchored end, or null when the submission gave none. */
  endDate: Date | null;
  /** True when the caller already supplied `eventDays` or `specificDates`. */
  hasExplicitDays: boolean;
  startTime?: string | null;
  endTime?: string | null;
}

/**
 * The calendar date (`YYYY-MM-DD`) of a one-day event that arrived with hours
 * but no per-day payload — or null when a day row must not be synthesized.
 *
 * Returns null, deliberately, when:
 *
 *  - the caller supplied its own days. Theirs wins; this is a fallback.
 *  - there is no start date. Nothing to hang a day on.
 *  - no time is known. A day row with two null times tells the reader
 *    nothing and trips the DQ4 `flaggedForReview` path for no gain.
 *  - the event spans more than one calendar day. Copying one time range
 *    across a range of dates would assert per-day hours nobody stated —
 *    the OPE-465 fabrication direction, which this fix must not trade for
 *    the omission it removes.
 */
export function singleDayWithHours(input: SingleDayHoursInput): string | null {
  const { startDate, endDate, hasExplicitDays, startTime, endTime } = input;
  if (hasExplicitDays) return null;
  if (startDate === null) return null;
  if (!startTime && !endTime) return null;
  // `normalizeEventDate` anchors at noon UTC, so slicing the ISO string
  // yields the intended calendar day rather than drifting a day west.
  const startDay = startDate.toISOString().slice(0, 10);
  if (endDate !== null && endDate.toISOString().slice(0, 10) !== startDay) return null;
  return startDay;
}

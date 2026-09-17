/**
 * OPE-456 — turn `gsc_milestone_emails` rows into chart points.
 *
 * The admin "Search clicks milestones" chart plotted `email_date`, so a
 * milestone Google dates precisely was drawn on the day someone forwarded the
 * email: 13K was reached 2026-08-19 and plotted (and shown as "Latest") on
 * 2026-08-24. The stored `reached_date` was already correct — the bug was on the
 * way to the screen. Extracted from the page so the date choice is testable.
 */

/** `source` value for a crossing computed from `gsc_daily_totals` (drizzle/0222). */
export const DERIVED_MILESTONE_SOURCE = "derived_from_gsc_daily_totals";

export interface MilestoneRow {
  threshold: number;
  emailDate: string;
  reachedDate: string | null;
  source: string;
}

export interface GscMilestonePoint {
  threshold: number;
  emailDate: string;
  reachedDate: string | null;
  /** What the chart plots: `reachedDate`, else `emailDate` for a row with none. */
  date: string;
  /** True when we computed this crossing ourselves; false = Google badge. */
  derived: boolean;
}

/**
 * Ordered by reached date, then threshold, so the line runs in the order the
 * thresholds were crossed rather than the order Google sent mail.
 */
export function toMilestonePoints(rows: MilestoneRow[]): GscMilestonePoint[] {
  return rows
    .map((r) => ({
      threshold: r.threshold,
      emailDate: r.emailDate,
      reachedDate: r.reachedDate,
      date: r.reachedDate ?? r.emailDate,
      derived: r.source === DERIVED_MILESTONE_SOURCE,
    }))
    .sort((a, b) => (a.date === b.date ? a.threshold - b.threshold : a.date < b.date ? -1 : 1));
}

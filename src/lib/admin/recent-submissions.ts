/**
 * OPE-1645 — the /admin "Recent Submissions" card: PENDING events that can
 * still be acted on, soonest first, each with its event date.
 *
 * It used to list the five OLDEST-created PENDING rows with no date. On
 * 2026-11-12, four of the five had already happened, while a fair two days
 * out (St. John's Vermont Products & Crafts Fair, Nov 14) waited out of sight.
 *
 * "Can still be acted on" is OPE-1596's rule (`pending-buckets.ts`), used as-is
 * so this card and /admin/submissions never disagree on what "ended" means:
 * the last day (end date, else start date) is today or later — or there is no
 * date at all, which can still be fixed. The footer's ended count is that
 * module's own count.
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { events, promoters, venues } from "@/lib/db/schema";
import type { Database } from "@/lib/db";
import { pendingBucketCounts, startOfUtcDay } from "@/lib/pending-buckets";

export const RECENT_SUBMISSIONS_LIMIT = 5;
/** A row starting within this many days is highlighted. */
export const SOON_DAYS = 7;

export interface RecentSubmission {
  id: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  datesConfirmed: boolean;
  createdAt: Date | null;
  promoterName: string | null;
  venueName: string | null;
}

export async function loadRecentSubmissions(
  db: Database,
  now: Date
): Promise<{ rows: RecentSubmission[]; endedCount: number }> {
  const cutoff = Math.floor(startOfUtcDay(now).getTime() / 1000);
  const last = sql`COALESCE(${events.endDate}, ${events.startDate})`;
  const [rows, counts] = await Promise.all([
    db
      .select({
        id: events.id,
        name: events.name,
        startDate: events.startDate,
        endDate: events.endDate,
        datesConfirmed: events.datesConfirmed,
        createdAt: events.createdAt,
        promoterName: promoters.companyName,
        venueName: venues.name,
      })
      .from(events)
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(
        and(
          eq(events.status, "PENDING"),
          or(sql`${last} >= ${cutoff}`, and(isNull(events.startDate), isNull(events.endDate)))
        )
      )
      // Soonest first; an undated row (still actionable) after every dated one;
      // submission time breaks ties.
      .orderBy(
        sql`CASE WHEN ${events.startDate} IS NULL AND ${events.endDate} IS NULL THEN 1 ELSE 0 END`,
        sql`COALESCE(${events.startDate}, ${events.endDate})`,
        asc(events.createdAt)
      )
      .limit(RECENT_SUBMISSIONS_LIMIT),
    pendingBucketCounts(db, now),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, datesConfirmed: !!r.datesConfirmed })),
    endedCount: counts.ended,
  };
}

/** True when the event starts (or is running) within SOON_DAYS of now. */
export function startsSoon(r: Pick<RecentSubmission, "startDate" | "endDate">, now: Date): boolean {
  const first = r.startDate ?? r.endDate;
  if (!first) return false;
  return new Date(first).getTime() - startOfUtcDay(now).getTime() < SOON_DAYS * 86_400_000;
}

/**
 * OPE-759 — raise `events.flagged_for_review` when any of an event's days
 * lacks hours.
 *
 * The RULE lives in `@takemetothefair/db-schema` because `event_days` has five
 * writers across two deploy artifacts and the decision has to be identical in
 * all of them. This is the app-side db call; `create_event_day` in the MCP
 * Worker already does the equivalent inline.
 *
 * ⚠️ MONOTONIC. It raises; it never clears. The reason is in
 * `shouldRaiseHoursFlag`'s docblock and it is not a shortcut:
 * `flagged_for_review` carries several independent reasons and nothing records
 * which one applies, so clearing on the hours axis would silently discharge a
 * series rollover's or a URL import's review obligation.
 */
import { and, eq, sql } from "drizzle-orm";
import { events, eventDays, unknownHoursCountSql, shouldRaiseHoursFlag } from "@/lib/db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@/lib/db/schema";

/**
 * Widest db shape this needs.
 *
 * Deliberately NOT `ReturnType<typeof getCloudflareDb>` — that resolves to a
 * type carrying `$client`, which the `Db` alias the insert helpers pass does
 * not have. Typing the requirement rather than one caller's concrete type is
 * what lets all four writers share this.
 */
type Db = DrizzleD1Database<typeof schema>;

export interface HoursFlagOutcome {
  daysChecked: number;
  unknownDays: number;
  flagRaised: boolean;
}

/**
 * Re-derive the hours axis for one event and raise the flag if needed.
 *
 * Returns what it OBSERVED, not just what it did. A caller — and a test — can
 * then assert on the decision rather than on an invisible side effect, and
 * "0 unknown of 0 days" stays distinguishable from "0 unknown of 12 days".
 * Only the second means the hours are confirmed.
 */
export async function raiseHoursReviewFlag(db: Db, eventId: string): Promise<HoursFlagOutcome> {
  const [counts] = await db
    .select({
      daysChecked: sql<number>`count(*)`,
      unknownDays: unknownHoursCountSql(),
    })
    .from(eventDays)
    .where(eq(eventDays.eventId, eventId));

  const observed = {
    daysChecked: Number(counts?.daysChecked ?? 0),
    unknownDays: Number(counts?.unknownDays ?? 0),
  };

  if (!shouldRaiseHoursFlag(observed)) {
    return { ...observed, flagRaised: false };
  }

  // Guarded on `flaggedForReview = 0` so a no-op does not churn `updatedAt` on
  // every day written to an already-flagged event — an import writing 400 days
  // would otherwise bump the parent row 400 times.
  await db
    .update(events)
    .set({ flaggedForReview: 1, updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.flaggedForReview, 0)));

  return { ...observed, flagRaised: true };
}

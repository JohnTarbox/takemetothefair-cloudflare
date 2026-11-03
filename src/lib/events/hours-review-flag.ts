/**
 * OPE-759 — raise `events.flagged_for_review` when any of an event's days
 * lacks hours.
 *
 * The RULE lives in `@takemetothefair/db-schema` because `event_days` has five
 * writers across two deploy artifacts and the decision has to be identical in
 * all of them. This is the app-side db call; `create_event_day` in the MCP
 * Worker already does the equivalent inline.
 *
 * OPE-767 — no longer monotonic. Reasons are now recorded per axis
 * (`event_review_flags`), so this raises `missing_hours` when a day lacks hours
 * and clears ONLY `missing_hours` when none do. Any other active reason keeps
 * the flag up — that was the whole reason it used to be raise-only.
 */
import { eq, sql } from "drizzle-orm";
import {
  eventDays,
  unknownHoursCountSql,
  shouldRaiseHoursFlag,
  raiseEventReviewFlag,
  clearEventReviewFlag,
} from "@/lib/db/schema";
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
  /** OPE-767 — the hours REASON was cleared (every day now has hours). */
  reasonCleared: boolean;
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

  if (shouldRaiseHoursFlag(observed)) {
    // OPE-767 — recorded as the `missing_hours` reason, so the hours axis can
    // later clear exactly this and nothing else. Idempotent.
    await raiseEventReviewFlag(db, eventId, "missing_hours");
    return { ...observed, flagRaised: true, reasonCleared: false };
  }

  // OPE-767 — the hours axis clears ITS OWN reason once every recorded day has
  // hours. It cannot discharge a rollover's or an import's review: those are
  // separate reasons, and the flag stays up while any of them is active.
  // `daysChecked === 0` is "no days recorded", not "hours confirmed".
  if (observed.daysChecked > 0 && observed.unknownDays === 0) {
    await clearEventReviewFlag(db, eventId, "missing_hours", "hours-axis");
    return { ...observed, flagRaised: false, reasonCleared: true };
  }
  return { ...observed, flagRaised: false, reasonCleared: false };
}

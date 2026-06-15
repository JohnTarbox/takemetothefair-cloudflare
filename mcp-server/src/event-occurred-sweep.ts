/**
 * K27 — daily OCCURRED auto-transition sweep (+ rollover).
 *
 * Premise: there was NO automated SCHEDULED→OCCURRED transition before K27 —
 * OCCURRED was set only by the one-time migration 0067 backfill and the manual
 * update_event_lifecycle tool, so past-end events sat in SCHEDULED indefinitely.
 * This sweep closes that gap and folds the recurring-event rollover into the
 * same pass.
 *
 * Two passes, both cosmetic-failsoft (each catches its own errors and logs to
 * error_logs — a single bad row never aborts the run or the sibling crons it
 * shares the daily Promise.all with):
 *
 *   Pass 1 — transition + roll. APPROVED events whose end_date has passed move
 *     SCHEDULED/RESCHEDULED/MOVED_ONLINE → OCCURRED (mirroring 0067's
 *     conservatism: only APPROVED auto-occur). Each transition then attempts a
 *     rollover. Transition and rollover are independently failsoft, so a roll
 *     failure never unwinds a committed transition.
 *
 *   Pass 2 — backfill rolls for events already OCCURRED with a recurrence rule
 *     (e.g. the 0067-backfilled corpus once their rules are seeded), EXCLUDING
 *     rows transitioned in this same run (lifecycle_status_changed_at == now)
 *     so Pass-1 rows are owned solely by Pass 1. rolloverEventIfRecurring is
 *     idempotent, so this is safe even if the exclusion misses.
 */
import { eq, and, or, inArray, lt, isNull, isNotNull } from "drizzle-orm";
import { events, adminActions } from "./schema.js";
import { rolloverEventIfRecurring } from "./event-rollover.js";
import { logError } from "./logger.js";
import type { Db } from "./db.js";

/** Per-run bounds — keep the sweep within cron CPU/subrequest limits. */
const TRANSITION_LIMIT = 200;
const BACKFILL_LIMIT = 200;

const SOURCE = "mcp/event-occurred-sweep";

export interface OccurredSweepResult {
  transitioned: number;
  rolledFromTransition: number;
  rolledFromBackfill: number;
  errors: number;
}

export async function runOccurredTransitionSweep(
  db: Db,
  opts?: { now?: Date }
): Promise<OccurredSweepResult> {
  const now = opts?.now ?? new Date();
  const result: OccurredSweepResult = {
    transitioned: 0,
    rolledFromTransition: 0,
    rolledFromBackfill: 0,
    errors: 0,
  };

  // --- Pass 1: transition past-end APPROVED events to OCCURRED, then roll ----
  let pass1: { id: string; slug: string; lifecycleStatus: string }[] = [];
  try {
    pass1 = await db
      .select({ id: events.id, slug: events.slug, lifecycleStatus: events.lifecycleStatus })
      .from(events)
      .where(
        and(
          eq(events.status, "APPROVED"),
          inArray(events.lifecycleStatus, ["SCHEDULED", "RESCHEDULED", "MOVED_ONLINE"]),
          isNotNull(events.endDate),
          lt(events.endDate, now),
          isNull(events.mergedInto)
        )
      )
      .orderBy(events.endDate)
      .limit(TRANSITION_LIMIT);
  } catch (error) {
    result.errors++;
    await logError(db, { message: "[occurred-sweep] pass-1 select failed", error, source: SOURCE });
  }

  for (const ev of pass1) {
    try {
      await db.batch([
        db
          .update(events)
          .set({
            lifecycleStatus: "OCCURRED",
            lifecycleStatusChangedAt: now,
            lifecycleReason: "auto: end date passed",
            updatedAt: now,
          })
          .where(eq(events.id, ev.id)),
        db.insert(adminActions).values({
          action: "event.lifecycle_change",
          actorUserId: null,
          targetType: "event",
          targetId: ev.id,
          payloadJson: JSON.stringify({
            previous_lifecycle: ev.lifecycleStatus,
            new_lifecycle: "OCCURRED",
            reason: "auto: end date passed",
            slug: ev.slug,
            via: "occurred-sweep",
          }),
          createdAt: now,
        }),
      ]);
      result.transitioned++;
    } catch (error) {
      result.errors++;
      await logError(db, {
        message: `[occurred-sweep] transition failed for ${ev.id}`,
        error,
        source: SOURCE,
      });
      continue;
    }

    // Rollover is independently failsoft — a failure here must not unwind the
    // committed OCCURRED transition above.
    try {
      const roll = await rolloverEventIfRecurring(db, ev.id, {
        via: "cron",
        actorUserId: null,
        now,
      });
      if (roll.created) result.rolledFromTransition++;
    } catch (error) {
      result.errors++;
      await logError(db, {
        message: `[occurred-sweep] rollover failed for ${ev.id}`,
        error,
        source: SOURCE,
      });
    }
  }

  // --- Pass 2: backfill rolls for already-OCCURRED recurring events ----------
  let pass2: { id: string }[] = [];
  try {
    pass2 = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.lifecycleStatus, "OCCURRED"),
          isNotNull(events.recurrenceRule),
          isNull(events.mergedInto),
          // Exclude rows flipped to OCCURRED in THIS run (changedAt == now);
          // those were already handled by Pass 1. NULL changedAt = migration-
          // backfilled historical OCCURRED → include.
          or(isNull(events.lifecycleStatusChangedAt), lt(events.lifecycleStatusChangedAt, now))
        )
      )
      .limit(BACKFILL_LIMIT);
  } catch (error) {
    result.errors++;
    await logError(db, { message: "[occurred-sweep] pass-2 select failed", error, source: SOURCE });
  }

  for (const ev of pass2) {
    try {
      const roll = await rolloverEventIfRecurring(db, ev.id, {
        via: "cron",
        actorUserId: null,
        now,
      });
      if (roll.created) result.rolledFromBackfill++;
    } catch (error) {
      result.errors++;
      await logError(db, {
        message: `[occurred-sweep] backfill rollover failed for ${ev.id}`,
        error,
        source: SOURCE,
      });
    }
  }

  return result;
}

/**
 * OPE-767 — WHY an event is flagged for review (John, 2026-09-30: option A).
 *
 * `events.flagged_for_review` was one boolean set by many independent writers,
 * and nothing recorded which. So nothing could ever safely clear it: filling in
 * a day's hours could not tell whether the row was ALSO an unreviewed rollover.
 * The flag only ever rose, and became noise a reviewer learns to ignore.
 *
 * Now every writer records its reason in `event_review_flags`, and
 * `events.flagged_for_review` is maintained as the OR of the active reasons:
 *
 *  - an axis that can be CHECKED clears itself (`missing_hours`, when the last
 *    unknown day gets hours) — and clears only its own reason;
 *  - a judgement axis (rollover, occurrence, former venue, past date, …) is
 *    cleared by a person, through the audited `clear_event_review_flag` tool;
 *  - rows flagged before this table existed carry `legacy` — an unknown reason,
 *    which no automatic axis can discharge.
 *
 * Writers MUST go through `raiseEventReviewFlag`; a structural test fails on a
 * bare `flaggedForReview` write to `events`. A flag raised without a reason row
 * would be silently lowered by the next axis that clears — the exact failure
 * this table exists to prevent.
 */
import { sql, type SQL } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { events } from "./index";

export const EVENT_REVIEW_FLAG_REASONS = [
  /** A day has no confirmed hours. Self-clearing (the hours axis). */
  "missing_hours",
  /** Auto-rolled from last year's edition; predicted dates need confirming. */
  "rollover",
  /** A new series occurrence was created and needs a look. */
  "new_occurrence",
  /** The matched venue is FORMER (closed) for these dates (OPE-1180). */
  "former_venue",
  /** The venue's state disagrees with the event's. */
  "venue_state_mismatch",
  /** The venue is outside New England. */
  "outside_new_england",
  /** A community (/suggest-event) submission. */
  "community_submission",
  /** Auto-created with a date already past — likely a past EDITION (OPE-201). */
  "past_dated",
  /** The extracted name is not grounded in the source (OPE-378). */
  "ungrounded_name",
  /** Flagged before reasons were recorded (drizzle/0341 backfill). */
  "legacy",
] as const;
export type EventReviewFlagReason = (typeof EVENT_REVIEW_FLAG_REASONS)[number];

export const eventReviewFlags = sqliteTable(
  "event_review_flags",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    raisedAt: integer("raised_at", { mode: "timestamp" }).notNull(),
    raisedBy: text("raised_by"),
    /** NULL while active. Cleared rows are kept — they are the audit trail. */
    clearedAt: integer("cleared_at", { mode: "timestamp" }),
    clearedBy: text("cleared_by"),
    note: text("note"),
  },
  (t) => ({
    byEvent: index("idx_event_review_flags_event").on(t.eventId, t.clearedAt),
  })
);

/** The narrowest thing both the app's D1 drizzle and the MCP's can satisfy. */
export interface ReviewFlagDb {
  run(query: SQL): unknown;
}

/**
 * Raise one reason on an event, and the flag with it. Idempotent: an already
 * ACTIVE (event, reason) is not duplicated, so a writer may call it on every
 * save. Call it AFTER the event row exists.
 */
// The id is minted in SQL, not with crypto.randomUUID(): this module is in the
// shared schema package, which reaches client bundles, and randomUUID is above
// the browser support floor (check-browser-api-floor).
export async function raiseEventReviewFlag(
  db: ReviewFlagDb,
  eventId: string,
  reason: EventReviewFlagReason,
  raisedBy: string | null = null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.run(sql`
    INSERT INTO event_review_flags (id, event_id, reason, raised_at, raised_by)
    SELECT lower(hex(randomblob(16))), ${eventId}, ${reason}, ${now}, ${raisedBy}
    WHERE NOT EXISTS (
      SELECT 1 FROM event_review_flags
      WHERE event_id = ${eventId} AND reason = ${reason} AND cleared_at IS NULL
    )`);
  await db.run(
    sql`UPDATE events SET flagged_for_review = 1 WHERE id = ${eventId} AND flagged_for_review = 0`
  );
}

/**
 * Clear ONE reason, then recompute the flag as the OR of what is still active.
 * Never touches another reason: filling in hours cannot discharge a rollover.
 * A no-op when the reason is not active.
 */
export async function clearEventReviewFlag(
  db: ReviewFlagDb,
  eventId: string,
  reason: EventReviewFlagReason,
  clearedBy: string | null = null,
  note: string | null = null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.run(sql`
    UPDATE event_review_flags SET cleared_at = ${now}, cleared_by = ${clearedBy}, note = coalesce(${note}, note)
    WHERE event_id = ${eventId} AND reason = ${reason} AND cleared_at IS NULL`);
  await db.run(sql`
    UPDATE events SET flagged_for_review = CASE WHEN EXISTS (
      SELECT 1 FROM event_review_flags WHERE event_id = ${eventId} AND cleared_at IS NULL
    ) THEN 1 ELSE 0 END
    WHERE id = ${eventId}`);
}

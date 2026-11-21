/**
 * OPE-1596 — nightly expiry of elapsed PENDING submissions (John, 2026-11-16,
 * option 1).
 *
 * A PENDING event whose end date (or start date, when end is null) is more
 * than EXPIRE_AFTER_DAYS past moves to REJECTED with reason
 * `elapsed_unreviewed`. Each row gets the same `event.expire_elapsed`
 * admin_actions row the /admin/submissions bulk button writes (main app
 * `src/lib/pending-buckets.ts`), with `via` naming this rule.
 *
 * - Rows a person touched in the last SKIP_TOUCHED_DAYS are left alone, so a
 *   row being worked isn't swept mid-review. "Touched" = `events.updated_at`
 *   in the window OR any admin_actions row with a non-null actor on it. Either
 *   signal skips the row; over-skipping only delays an expiry by a night.
 * - Sends no email: reject notifies nobody (only approval notifies a
 *   submitter). The run's summary is one line in the operator digest.
 * - One `event.elapsed_expiry_run` admin_actions row and one
 *   `watchdog:elapsed-pending-expiry` heartbeat per run, including a run
 *   that expired nothing — the OPE-246 probe watches the stamp, not yield.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import { adminActions, agentHeartbeats, events } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";

export const EXPIRE_AFTER_DAYS = 3;
export const SKIP_TOUCHED_DAYS = 7;
/** Per-run cap; the live backlog at ship was 64 rows. */
export const EXPIRE_LIMIT = 300;

export const ELAPSED_REASON = "elapsed_unreviewed";
export const EXPIRY_VIA = "elapsed-pending-expiry";
export const EXPIRY_ROW_ACTION = "event.expire_elapsed";
export const EXPIRY_RUN_ACTION = "event.elapsed_expiry_run";
export const EXPIRY_HEARTBEAT_CODE = "watchdog:elapsed-pending-expiry";
const SOURCE = "mcp/elapsed-pending-expiry";

export interface ElapsedExpiryResult {
  /** PENDING rows past the cutoff, before the touched-row skip. */
  elapsed: number;
  /** Of those, skipped because a person touched them recently. */
  skippedTouched: number;
  expired: { id: string; slug: string }[];
  errors: number;
  summary: string;
}

export function summarizeExpiry(r: Omit<ElapsedExpiryResult, "summary">): string {
  return (
    `expired ${r.expired.length} elapsed PENDING row${r.expired.length === 1 ? "" : "s"}` +
    ` (${r.elapsed} past end+${EXPIRE_AFTER_DAYS}d; ${r.skippedTouched} skipped, touched in the last ${SKIP_TOUCHED_DAYS}d` +
    (r.errors ? `; ${r.errors} error${r.errors === 1 ? "" : "s"}` : "") +
    ")"
  );
}

export async function runElapsedPendingExpiry(
  db: Db,
  opts: { now?: Date } = {}
): Promise<ElapsedExpiryResult> {
  const now = opts.now ?? new Date();
  const nowSecs = Math.floor(now.getTime() / 1000);
  const cutoff = nowSecs - EXPIRE_AFTER_DAYS * 86400;
  const touchedSince = nowSecs - SKIP_TOUCHED_DAYS * 86400;
  const last = sql`COALESCE(${events.endDate}, ${events.startDate})`;
  const elapsedWhere = and(eq(events.status, "PENDING"), sql`${last} < ${cutoff}`);

  const result: Omit<ElapsedExpiryResult, "summary"> = {
    elapsed: 0,
    skippedTouched: 0,
    expired: [],
    errors: 0,
  };

  try {
    const candidates = await db
      .select({
        id: events.id,
        slug: events.slug,
        touched: sql<number>`CASE
          WHEN ${events.updatedAt} >= ${touchedSince} THEN 1
          WHEN EXISTS (
            SELECT 1 FROM admin_actions a
            WHERE a.target_type = 'event' AND a.target_id = "events"."id"
              AND a.actor_user_id IS NOT NULL AND a.created_at >= ${touchedSince}
          ) THEN 1
          ELSE 0 END`,
        // ⚠️ The outer column is spelled out: drizzle renders ${events.id}
        // as a bare "id", which inside this subquery binds to admin_actions.id
        // and silently disables the admin-action skip (caught by the test).
      })
      .from(events)
      .where(elapsedWhere)
      .orderBy(last)
      .limit(EXPIRE_LIMIT);

    result.elapsed = candidates.length;
    const eligible = candidates.filter((c) => Number(c.touched) === 0);
    result.skippedTouched = candidates.length - eligible.length;

    for (const chunk of chunkIds(eligible.map((c) => c.id))) {
      // Guards repeated in the UPDATE: a row approved or edited since the
      // SELECT is left alone, not trusted.
      const rows = await db
        .update(events)
        .set({ status: "REJECTED", updatedAt: now })
        .where(
          and(
            inArray(events.id, chunk),
            elapsedWhere,
            sql`(${events.updatedAt} IS NULL OR ${events.updatedAt} < ${touchedSince})`
          )
        )
        .returning({ id: events.id, slug: events.slug });
      result.expired.push(...rows.map((r) => ({ id: r.id, slug: String(r.slug) })));
    }

    // Six bound values per row keeps a batch of 15 under D1's 100-parameter cap.
    for (const chunk of chunkIds(
      result.expired.map((e) => e.id),
      15
    )) {
      await db.insert(adminActions).values(
        chunk.map((id) => ({
          action: EXPIRY_ROW_ACTION,
          actorUserId: null,
          targetType: "event",
          targetId: id,
          payloadJson: JSON.stringify({
            reason: ELAPSED_REASON,
            from: "PENDING",
            to: "REJECTED",
            via: EXPIRY_VIA,
            rule: "OPE-1596",
          }),
          createdAt: now,
        }))
      );
    }
  } catch (error) {
    result.errors++;
    await logError(db, { source: SOURCE, message: "[elapsed-pending-expiry] run failed", error });
  }

  const summary = summarizeExpiry(result);
  try {
    await db.insert(adminActions).values({
      action: EXPIRY_RUN_ACTION,
      actorUserId: null,
      targetType: "system",
      targetId: EXPIRY_VIA,
      payloadJson: JSON.stringify({
        summary,
        elapsed: result.elapsed,
        skippedTouched: result.skippedTouched,
        expired: result.expired.map((e) => e.slug),
        errors: result.errors,
      }),
      createdAt: now,
    });
    const note = `elapsed=${result.elapsed} expired=${result.expired.length} skipped=${result.skippedTouched} errors=${result.errors}`;
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: EXPIRY_HEARTBEAT_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    await logError(db, {
      source: SOURCE,
      message: "[elapsed-pending-expiry] run record failed",
      error,
    });
  }

  console.log(`[cron] elapsed-pending-expiry — ${summary}`);
  return { ...result, summary };
}

/** The newest run's summary within `withinHours`, for the operator digest. */
export async function readLatestElapsedExpiryRun(
  db: Db,
  now: Date,
  withinHours = 26
): Promise<{ summary: string; createdAt: Date } | null> {
  const since = Math.floor((now.getTime() - withinHours * 3600_000) / 1000);
  const [row] = await db
    .select({ payload: adminActions.payloadJson, createdAt: adminActions.createdAt })
    .from(adminActions)
    .where(
      and(eq(adminActions.action, EXPIRY_RUN_ACTION), sql`${adminActions.createdAt} >= ${since}`)
    )
    .orderBy(sql`${adminActions.createdAt} DESC`)
    .limit(1);
  if (!row?.payload) return null;
  try {
    const p = JSON.parse(row.payload) as { summary?: string };
    return { summary: p.summary ?? "", createdAt: row.createdAt };
  } catch {
    return null;
  }
}

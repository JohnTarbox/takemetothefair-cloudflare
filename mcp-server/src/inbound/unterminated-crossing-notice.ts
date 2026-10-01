/**
 * OPE-366 (R2) — the E2 conditional PUSH for unterminated membrane crossings.
 *
 * PR #852 built the detector (`findUnterminatedCrossings`) and put its count in
 * the Monday inventory, so the backlog had a standing line. What it never had
 * was a push: a dead-end on Tuesday surfaced the following Monday as a number,
 * which is how ten of twelve `email_to_ticket` crossings sat unread in August.
 * John ruled 2026-09-30: wire the OPE-308 E2 push, induce one failure, send it
 * to john@pimboat.com, keep `email_to_hold` excluded (the detector already
 * excludes it, with its reason, in unterminated-crossings.ts).
 *
 * ## When it speaks
 *
 * Hourly (MCP `0 * * * *` cron). It pushes only when an unterminated crossing
 * exists whose `created_at` is NEWER than the high-water mark of the last
 * notice — i.e. a new dead-end has aged past the threshold since we last
 * spoke. The standing backlog is the Monday inventory's job; re-alarming on it
 * every hour is how a channel stops being read (the OPE-308 alert diet).
 *
 * The first run has no state row and reports the whole backlog once — the
 * ticket's "report the backlog once on landing", so the detector does not
 * begin from a silently-clean slate.
 *
 * ## Recipient
 *
 * `UNTERMINATED_CROSSING_ALERT_EMAIL` (committed [vars]), per the ruling. Not
 * ALERT_EMAIL_TECHNICAL, which goes to a different pair of addresses.
 *
 * ## Evidence
 *
 * Every completed run — notified or not — stamps agent_heartbeats
 * `watchdog:unterminated-crossing-notice`; the OPE-246 heartbeat probe watches
 * it. A run that throws before finishing writes no stamp, so a broken notice
 * goes silent on the probe instead of looking healthy.
 */
import { eq } from "drizzle-orm";
import { agentHeartbeats, unterminatedCrossingNoticeState } from "../schema.js";
import type { Db } from "../db.js";
import { logError } from "../logger.js";
import {
  ageHoursFrom,
  findUnterminatedCrossings,
  type UnterminatedCrossing,
} from "./unterminated-crossings.js";

const SOURCE = "mcp:schedule:unterminated-crossing-notice";
const NOTICE_KEY = "unterminated_crossing_notice";
export const UNTERMINATED_NOTICE_RUN_CODE = "watchdog:unterminated-crossing-notice";
const SAMPLE_LIMIT = 10;

export interface UnterminatedNoticeEnv {
  DB: D1Database;
  EMAIL_JOBS?: { send: (body: unknown) => Promise<unknown> };
  UNTERMINATED_CROSSING_ALERT_EMAIL?: string;
  UNTERMINATED_CROSSING_AGE_HOURS?: string;
}

export interface UnterminatedNoticeDecision {
  notify: boolean;
  /** The crossings that are new since the last notice (all of them on landing). */
  fresh: UnterminatedCrossing[];
  landing: boolean;
}

/**
 * Pure gate — exported for tests. `crossings` is newest-first, as the detector
 * returns it. `highWater` is null when no notice has ever been sent.
 */
export function decideUnterminatedNotice(
  crossings: UnterminatedCrossing[],
  highWater: Date | null
): UnterminatedNoticeDecision {
  if (crossings.length === 0) return { notify: false, fresh: [], landing: highWater === null };
  if (highWater === null) return { notify: true, fresh: crossings, landing: true };
  const fresh = crossings.filter((c) => c.createdAt.getTime() > highWater.getTime());
  return { notify: fresh.length > 0, fresh, landing: false };
}

export function buildUnterminatedNotice(
  decision: UnterminatedNoticeDecision,
  total: number,
  ageHours: number
): { subject: string; text: string } {
  const n = decision.fresh.length;
  const subject = decision.landing
    ? `🕳️ Membrane dead-ends: ${total} crossing(s) never reached a destination (first report)`
    : `🕳️ Membrane dead-end: ${n} new crossing(s) with no destination after ${ageHours}h`;
  const lines = decision.fresh
    .slice(0, SAMPLE_LIMIT)
    .map(
      (c) =>
        ` • ${c.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z  ${c.crossingType}  ` +
        `${c.sourceRef}${c.notes ? `  — ${c.notes}` : ""}`
    );
  const more = n > SAMPLE_LIMIT ? `\n …and ${n - SAMPLE_LIMIT} more.` : "";
  const text =
    (decision.landing
      ? `First run of the unterminated-crossing alarm (OPE-366). This is the standing backlog, ` +
        `reported once; from now on this email fires only for NEW dead-ends.\n\n`
      : `Work crossed a membrane and never arrived anywhere: these crossings have had no ` +
        `destination for over ${ageHours}h.\n\n`) +
    `${lines.join("\n")}${more}\n\n` +
    `Total unterminated now: ${total} (email_to_hold excluded — a hold is a legitimate resting ` +
    `state). The count also appears in the Monday inventory.\n` +
    `Read the crossing: SELECT * FROM membrane_crossings WHERE source_ref = '<ref>';\n`;
  return { subject, text };
}

export async function runUnterminatedCrossingNotice(
  env: UnterminatedNoticeEnv,
  db: Db,
  now: Date = new Date()
): Promise<{ notified: boolean; fresh: number; total: number } | null> {
  const ageHours = ageHoursFrom(env);
  let crossings: UnterminatedCrossing[];
  let highWater: Date | null = null;
  try {
    crossings = await findUnterminatedCrossings(db, now, { ageHours });
    const state = await db
      .select()
      .from(unterminatedCrossingNoticeState)
      .where(eq(unterminatedCrossingNoticeState.id, NOTICE_KEY))
      .limit(1);
    highWater = state[0]?.highWaterCreatedAt ?? null;
  } catch (error) {
    await logError(env.DB, { source: SOURCE, message: "unterminated-crossing read failed", error });
    return null;
  }

  const decision = decideUnterminatedNotice(crossings, highWater);
  let notified = false;
  if (decision.notify) {
    const to = env.UNTERMINATED_CROSSING_ALERT_EMAIL?.trim();
    if (!to || !env.EMAIL_JOBS) {
      // A condition that holds with nowhere to send it is itself a fault.
      // Do NOT advance the high-water mark: the dead-ends stay "new" until a
      // notice can actually be delivered.
      await logError(env.DB, {
        level: "warn",
        source: SOURCE,
        message: "unterminated crossings found but no recipient/queue configured",
        context: { fresh: decision.fresh.length, hasTo: !!to, hasQueue: !!env.EMAIL_JOBS },
      });
    } else {
      const { subject, text } = buildUnterminatedNotice(decision, crossings.length, ageHours);
      try {
        await env.EMAIL_JOBS.send({ to, subject, text, source: "unterminated-crossing-notice" });
        notified = true;
      } catch (error) {
        await logError(env.DB, {
          source: SOURCE,
          message: "unterminated-crossing notice enqueue failed",
          error,
        });
      }
    }
  }

  try {
    if (notified) {
      // crossings is newest-first, so [0] is the high-water mark.
      const newest = crossings[0].createdAt;
      await db
        .insert(unterminatedCrossingNoticeState)
        .values({
          id: NOTICE_KEY,
          highWaterCreatedAt: newest,
          lastCount: crossings.length,
          lastNotifiedAt: now,
        })
        .onConflictDoUpdate({
          target: unterminatedCrossingNoticeState.id,
          set: { highWaterCreatedAt: newest, lastCount: crossings.length, lastNotifiedAt: now },
        });
    }
    const note = `unterminated=${crossings.length} fresh=${decision.fresh.length} notified=${notified}`;
    await db
      .insert(agentHeartbeats)
      .values({ agentCode: UNTERMINATED_NOTICE_RUN_CODE, kind: "watchdog", lastSeenAt: now, note })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    await logError(env.DB, {
      source: SOURCE,
      message: "unterminated-crossing state/stamp write failed",
      error,
    });
  }

  return { notified, fresh: decision.fresh.length, total: crossings.length };
}

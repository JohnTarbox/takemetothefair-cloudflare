/**
 * OPE-1205 — a synced row stops claiming confirmed dates once its source has
 * gone quiet.
 *
 * `harvest-festival-of-crafts-2026` was `direct_scrape`, `sync_enabled`, last
 * synced 2026-01-27 — 240 days before the fair — and kept `dates_confirmed = 1`
 * on an Oct 23–25 date the organizer had since moved to Oct 31 – Nov 1. OPE-1200
 * gated the WRITE of `dates_confirmed = true`; nothing aged an existing TRUE.
 *
 * Daily: every upcoming, public, `sync_enabled` row whose last sync (or, never
 * synced, its creation) is older than N days, still claims confirmed dates, and
 * has NO qualifying start_date citation (the OPE-1200 rule — active, not a
 * community submission, not an aggregator) is set to `dates_confirmed = 0`.
 * A cited row is exempt: its confirmation rests on the citation, not the sync.
 *
 * N is `tunable_thresholds.sync_stale_dates_confirmed_days` (default 90, seeded
 * in drizzle/0334 with the measurement behind it). Each downgrade writes one
 * `admin_actions` row (the rollback record: set it back from that list), and
 * every run writes one run row — the heartbeat probe's evidence, so a sweep
 * that finds nothing still proves it ran.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { isQualifyingDateCitation } from "@takemetothefair/utils";
import { adminActions, eventDataCitations, events, tunableThresholds } from "./schema.js";
import { getDb, type Db } from "./db.js";
import type { Env } from "./index.js";
import { logError } from "./logger.js";

export const SYNC_STALE_THRESHOLD_KEY = "sync_stale_dates_confirmed_days";
export const SYNC_STALE_DEFAULT_DAYS = 90;
export const SYNC_STALE_RUN_ACTION = "event.sync_stale_sweep";
export const SYNC_STALE_DOWNGRADE_ACTION = "event.dates_confirmed_downgraded_stale_sync";

export async function loadSyncStaleDays(db: Db): Promise<number> {
  try {
    const [t] = await db
      .select({ value: tunableThresholds.value })
      .from(tunableThresholds)
      .where(eq(tunableThresholds.key, SYNC_STALE_THRESHOLD_KEY))
      .limit(1);
    if (typeof t?.value === "number" && t.value > 0) return t.value;
  } catch {
    /* fall back to the default */
  }
  return SYNC_STALE_DEFAULT_DAYS;
}

export interface SyncStaleResult {
  thresholdDays: number;
  candidates: number;
  downgraded: string[];
  exemptCited: number;
}

export async function runSyncStaleSweep(db: Db, now: Date = new Date()): Promise<SyncStaleResult> {
  const thresholdDays = await loadSyncStaleDays(db);
  const nowSec = Math.floor(now.getTime() / 1000);
  const cutoffSec = nowSec - Math.round(thresholdDays * 86400);

  const candidates = await db
    .select({ id: events.id, slug: events.slug, lastSyncedAt: events.lastSyncedAt })
    .from(events)
    .where(
      and(
        eq(events.syncEnabled, true),
        eq(events.datesConfirmed, true),
        sql`${events.mergedInto} IS NULL`,
        inArray(events.status, ["APPROVED", "TENTATIVE"]),
        gt(sql`COALESCE(${events.endDate}, ${events.startDate})`, nowSec),
        sql`COALESCE(${events.lastSyncedAt}, ${events.createdAt}) < ${cutoffSec}`
      )
    );

  const downgraded: string[] = [];
  let exemptCited = 0;
  for (const c of candidates) {
    const cites = await db
      .select({
        fieldName: eventDataCitations.fieldName,
        state: eventDataCitations.state,
        sourceType: eventDataCitations.sourceType,
        sourceUrl: eventDataCitations.sourceUrl,
      })
      .from(eventDataCitations)
      .where(
        and(eq(eventDataCitations.eventId, c.id), eq(eventDataCitations.fieldName, "start_date"))
      );
    if (cites.some((c) => isQualifyingDateCitation(c))) {
      exemptCited++;
      continue;
    }
    // Conditional on still-TRUE: idempotent, and a concurrent re-confirmation wins.
    const res = await db
      .update(events)
      .set({ datesConfirmed: false })
      .where(and(eq(events.id, c.id), eq(events.datesConfirmed, true)))
      .returning({ id: events.id });
    if (res.length === 0) continue;
    downgraded.push(c.id);
    await db.insert(adminActions).values({
      action: SYNC_STALE_DOWNGRADE_ACTION,
      actorUserId: null,
      targetType: "event",
      targetId: c.id,
      payloadJson: JSON.stringify({
        slug: c.slug,
        lastSyncedAt: c.lastSyncedAt ? c.lastSyncedAt.toISOString() : null,
        thresholdDays,
      }),
      createdAt: now,
    });
  }

  await db.insert(adminActions).values({
    action: SYNC_STALE_RUN_ACTION,
    actorUserId: null,
    targetType: "events",
    targetId: "sync-stale-sweep",
    payloadJson: JSON.stringify({
      thresholdDays,
      candidates: candidates.length,
      downgraded: downgraded.length,
      exemptCited,
    }),
    createdAt: now,
  });

  return { thresholdDays, candidates: candidates.length, downgraded, exemptCited };
}

/** Cron entry — failsoft, like the sibling daily jobs: logs, never throws. */
export async function runScheduledSyncStaleSweep(env: Env): Promise<void> {
  try {
    await runSyncStaleSweep(getDb(env.DB));
  } catch (err) {
    await logError(env.DB, {
      source: "mcp:schedule:sync-stale-sweep",
      message: "sync-stale sweep failed",
      error: err,
    }).catch(() => {});
  }
}

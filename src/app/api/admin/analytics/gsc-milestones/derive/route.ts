export const dynamic = "force-dynamic";
/**
 * OPE-456 — record derived click-milestone crossings from settled GSC dailies.
 *
 * POST, no body. Auth: admin session OR X-Internal-Key (the MCP daily cron runs
 * it straight after the gsc-metrics sync).
 *
 * Logs an info row on EVERY run, crossing or not. The heartbeat probe watches
 * that row rather than `gsc_milestone_emails`: a milestone lands every few days
 * at best and never while traffic is flat, so probing the yield would go red on
 * a quiet month and stay green on a cron that had stopped.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import {
  DERIVE_LOG_SOURCE,
  recordDerivedMilestones,
} from "@/lib/analytics/record-derived-milestones";

export const POST = withAuthorized(async ({ db }) => {
  try {
    const r = await recordDerivedMilestones(db, new Date());
    await logError(db, {
      level: "info",
      source: DERIVE_LOG_SOURCE,
      message:
        r.inserted.length > 0
          ? `recorded ${r.inserted.length} derived milestone(s): ${r.inserted.map((c) => `${c.threshold}@${c.reachedDate}`).join(", ")}`
          : `no new milestone crossings through ${r.settledThrough}`,
      context: {
        settledThrough: r.settledThrough,
        settledDays: r.settledDays,
        alreadyRecorded: r.alreadyRecorded,
      },
    });
    return NextResponse.json({
      ok: true,
      settled_through: r.settledThrough,
      settled_days: r.settledDays,
      inserted: r.inserted,
      already_recorded: r.alreadyRecorded,
    });
  } catch (err) {
    await logError(db, {
      source: DERIVE_LOG_SOURCE,
      message: "derived milestone run failed",
      error: err,
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
});

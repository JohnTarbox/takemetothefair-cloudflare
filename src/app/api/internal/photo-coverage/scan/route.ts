export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { refreshImageCoverageState } from "@/lib/photo-coverage/scan";
import { loadCoverageState, persistPhotoCoverageSnapshot } from "@/lib/photo-effectiveness/load";

/**
 * POST /api/internal/photo-coverage/scan  (OPE-225)
 *
 * The single writer of `image_coverage_state`. Observes every live entity's
 * current image, joins 28-day GSC demand, and reconciles. Auth: X-Internal-Key
 * (called by the MCP daily cron, alongside the other CPI scans).
 *
 * Idempotent by construction — running it twice changes nothing but
 * `checked_at`, and never re-stamps `image_set_at`. That means a retry after a
 * partial failure is always safe, which is why there is no run-lock.
 *
 * Guarded by the `image-coverage-scan` heartbeat probe (OPE-246): the probe
 * reads `max(checked_at)`, so if this route stops being called the silence
 * escalates through the OPE-75 digest rather than going unnoticed — the whole
 * reason the probe ships in the same PR as the writer.
 */
export const POST = withInternalKey(async () => {
  try {
    const db = getCloudflareDb();
    const now = new Date();
    const result = await refreshImageCoverageState(db, now);

    /**
     * OPE-226 — append today's coverage snapshot.
     *
     * `image_coverage_state` is overwritten in place every scan, so this is the
     * only moment the day's coverage exists to be recorded; without it there is
     * no trend to report, only a single point.
     *
     * Written even when the scan was INCOMPLETE, carrying `result.complete` so
     * the trend can exclude the day. Skipping the write instead would leave a
     * hole that reads as "coverage unchanged" — the failure mode this whole
     * ticket family exists to stop. Fail-soft: a snapshot error must not turn a
     * good scan into a failed one, so it is logged and the scan result stands.
     */
    let snapshot: { date: string; written: number } | null = null;
    try {
      const rows = await loadCoverageState(db);
      snapshot = await persistPhotoCoverageSnapshot(db, rows, result.complete, now);
    } catch (err) {
      await logError(null, {
        level: "warn",
        source: "photo-coverage:scan",
        message: "coverage snapshot write failed; scan result still stands",
        error: err,
      });
    }

    // A PARTIAL scan must not report success. The first production run wrote
    // events + part of vendors and was killed before venues/promoters/
    // performers — leaving coverage numbers that looked healthy for a table
    // that was missing two-thirds of the site, with nothing logged because the
    // isolate died rather than threw. Reporting 200 on that is the actual bug.
    if (!result.complete) {
      await logError(null, {
        level: "error",
        source: "photo-coverage:scan",
        message: "image coverage scan INCOMPLETE — coverage numbers are not trustworthy",
        context: {
          scanned: result.scanned,
          writtenByType: result.writtenByType,
        },
      });
      return NextResponse.json(
        { success: false, incomplete: true, snapshot, ...result },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, snapshot, ...result });
  } catch (err) {
    // Surfaced, not swallowed: a scan that fails silently would leave the
    // coverage numbers frozen at their last good value and still look healthy.
    await logError(null, {
      level: "error",
      source: "photo-coverage:scan",
      message: "image coverage scan failed",
      error: err,
    });
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
});

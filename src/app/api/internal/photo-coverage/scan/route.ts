export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { refreshImageCoverageState } from "@/lib/photo-coverage/scan";

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
    const result = await refreshImageCoverageState(db, new Date());
    return NextResponse.json({ success: true, ...result });
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

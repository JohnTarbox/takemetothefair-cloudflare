export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";
import { ROT_SWEEP_LIMIT, sweepImageUrlHealth } from "@/lib/photo-coverage/rot";

/**
 * POST /api/internal/photo-coverage/url-health   (OPE-225 PR 2/2)
 *
 * Fetches the least-recently-checked image URLs and records which are dead
 * (scope §4's measured half). Auth: X-Internal-Key (daily cron).
 *
 * Deliberately partial per run: a Worker invocation has ~30s of outbound
 * wall-clock, so this round-robins `?limit=` URLs (default 60) rather than
 * sweeping all ~1,000 imaged entities. Full coverage accrues over days, which
 * is also gentler on the third-party hosts we hotlink from.
 *
 * Guarded by the `image-url-health-sweep` heartbeat probe, whose evidence is
 * `max(url_checked_at)` — so if this stops being called the silence escalates
 * through the OPE-75 digest instead of the rot flag quietly freezing.
 */
const MAX_LIMIT = 200;

export const POST = withInternalKey(async ({ request, db }) => {
  try {
    const limitParam = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Math.min(
      Math.max(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : ROT_SWEEP_LIMIT, 1),
      MAX_LIMIT
    );

    const result = await sweepImageUrlHealth(db, { limit });
    return NextResponse.json({ success: true, limit, ...result });
  } catch (err) {
    await logError(null, {
      level: "error",
      source: "photo-coverage:url-health",
      message: "image URL health sweep failed",
      error: err,
    });
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
});

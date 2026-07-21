export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { TREND_WINDOW_DAYS, loadPhotoScorecard } from "@/lib/photo-effectiveness/load";

/**
 * GET /api/admin/analytics/photo-effectiveness   (OPE-226)
 *
 * "Are the photos actually working?" — the measurement counterpart to OPE-225's
 * coverage rail. Auth: admin session OR X-Internal-Key.
 *
 * Four blocks, matching the ticket's scope:
 *   1. coverage[]         — coverage trend by demand tier, per entity type
 *   2. lift               — WITHIN-PAGE before/after CTR against image_set_at
 *   3. jsonLdImagePct     — events emitting a real image vs the og-default
 *   4. health             — hotlinked / unreachable, trended
 *
 * Two fields exist to stop this endpoint lying by omission, and consumers should
 * render both rather than only the percentages:
 *
 *   `unmeasuredTypes` — entity types absent from the newest snapshot. A type
 *   with no rows is NOT 0% coverage, it is unmeasured, and the two demand
 *   opposite responses. On 2026-07-21 this was venues, promoters and performers
 *   — 1,801 entities that a plain rollup would have rendered as a tidy 0%.
 *
 *   `lift.note` — the sample-size statement. A lift number over a handful of
 *   pages is noise, and this scorecard gates an automation rollout, so the
 *   caveat travels with the figure instead of living in a doc nobody opens.
 *
 * ?days=N sets the trend window (default 90, max 365).
 */
const MAX_TREND_DAYS = 365;

export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const trendDays = Math.min(
    Math.max(Number(url.searchParams.get("days")) || TREND_WINDOW_DAYS, 1),
    MAX_TREND_DAYS
  );

  const db = getCloudflareDb();
  const scorecard = await loadPhotoScorecard(db, { trendDays });

  return NextResponse.json({ success: true, ...scorecard });
}

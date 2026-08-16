export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { and, gte, inArray, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { analyticsEvents } from "@/lib/db/schema";
import {
  FUNNELS,
  FUNNEL_STEPS,
  ALL_FUNNEL_STEP_NAMES,
  computeStepRatios,
  type Funnel,
} from "@/lib/analytics/funnel-steps";

/**
 * GET /api/admin/analytics/funnel?days=7  (OPE-364)
 *
 * The read path. The ticket is explicit that an instrument nobody can read does
 * not close it — a half-built pipeline whose missing half is the connection is
 * the membrane-family pattern this project keeps re-filing.
 *
 * Returns per-step counts AND the ratio to the previous step, split by device
 * class, because the aggregate is exactly the view that hid OPE-361: a
 * mobile-only break is diluted by desktop traffic into a modest dip.
 *
 * ⚠️ READ THE `completeness` FIELD BEFORE SUMMING ANYTHING. These counts are
 * near-complete per user but lossy in the tail (per-client beacon rate limit,
 * JS-disabled clients). The loss applies to every step roughly equally, so the
 * RATIOS are the trustworthy part and the absolute counts are a floor. This
 * mirrors the GSC dimensioned-rows incident, where summing a windowed source
 * undercounted clicks by 65% and was caught only by Google's own email.
 */
const MAX_DAYS = 90;

export async function GET(request: NextRequest) {
  // Admin session OR X-Internal-Key, matching the sibling analytics routes.
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = getCloudflareDb();

  const url = new URL(request.url);
  const daysRaw = Number(url.searchParams.get("days") ?? 7);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), MAX_DAYS) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // One grouped scan for every step across every funnel, split by the
  // server-derived device dimension. json_extract on `properties` is why the
  // device is written there rather than inferred at read time — a read-time
  // guess would have no answer for rows written before OPE-364.
  const rows = await db
    .select({
      eventName: analyticsEvents.eventName,
      device: sql<string>`COALESCE(json_extract(${analyticsEvents.properties}, '$.device'), 'unknown')`,
      n: sql<number>`count(*)`,
    })
    .from(analyticsEvents)
    .where(
      and(
        inArray(analyticsEvents.eventName, [...ALL_FUNNEL_STEP_NAMES]),
        gte(analyticsEvents.timestamp, since)
      )
    )
    .groupBy(
      analyticsEvents.eventName,
      sql`COALESCE(json_extract(${analyticsEvents.properties}, '$.device'), 'unknown')`
    );

  // device -> step -> count, plus an "all" rollup.
  const byDevice = new Map<string, Record<string, number>>();
  const all: Record<string, number> = {};
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    const bucket = byDevice.get(r.device) ?? {};
    bucket[r.eventName] = (bucket[r.eventName] ?? 0) + n;
    byDevice.set(r.device, bucket);
    all[r.eventName] = (all[r.eventName] ?? 0) + n;
  }

  const funnels = Object.fromEntries(
    FUNNELS.map((f: Funnel) => [
      f,
      {
        steps: FUNNEL_STEPS[f],
        all: computeStepRatios(f, all),
        byDevice: Object.fromEntries(
          [...byDevice.entries()].map(([d, counts]) => [d, computeStepRatios(f, counts)])
        ),
      },
    ])
  );

  return NextResponse.json({
    windowDays: days,
    since: since.toISOString(),
    funnels,
    completeness: {
      summable: false,
      reason:
        "First-party beacon, near-complete per user but lossy in the tail: the analytics-track " +
        "rate limit drops events past 60/hour anonymous (120 authenticated) PER CLIENT, and " +
        "JS-disabled clients emit nothing. Not ad-blocked (first-party endpoint), so the usual " +
        "analytics undercount does not apply. Loss is roughly uniform across steps, so " +
        "ratioFromPrevious is trustworthy and counts are a FLOOR, not a total.",
      startedAt: "2026-08-16 (OPE-364) — rows before this date have no device dimension",
    },
  });
}

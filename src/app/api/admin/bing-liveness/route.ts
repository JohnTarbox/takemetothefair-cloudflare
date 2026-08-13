export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, bingLivenessLog } from "@/lib/db/schema";
import { getCrawlStats, type BingEnv } from "@/lib/bing-webmaster";
import {
  classifyBingLiveness,
  nextConsecutiveFailures,
  shouldAlertOnStreak,
} from "@/lib/bing-liveness";

/**
 * OPE-309 (assurance audit A5) — daily Bing Webmaster API liveness check.
 *
 * Fired by the MCP-Worker 06:00Z batch alongside the GA4 check. Pings
 * `GetCrawlStats`, classifies green/degraded/critical from how far past its
 * day-end the newest row is, and carries a consecutive-failure streak forward.
 *
 * ── This endpoint CANNOT touch IndexNow ──
 *
 * IndexNow is under a latched Bing 429 with the operator breaker deliberately
 * engaged (OPE-243; no probe before 2026-09-10), so a liveness check that
 * accidentally submitted a URL would re-arm the very block we are waiting out.
 * It cannot: `GetCrawlStats` is a read-only Webmaster API GET on a different
 * service from IndexNow's submission endpoint, it goes nowhere near
 * `pingIndexNow` or the REL4/REL6 breaker, and it submits nothing.
 *
 * ── Why the cache is bypassed ──
 *
 * `getCrawlStats` caches for 15 minutes in KV. A liveness probe reading its own
 * cache is not a liveness probe — it would report a dead API as healthy for a
 * full cache window. `skipCache: true` is load-bearing, not an optimisation.
 *
 * ── Where the escalation actually goes ──
 *
 * The `admin_actions` row below is an AUDIT TRAIL, not the alarm. Nothing in
 * the codebase reads `admin_actions` as an alert channel — the operator-facing
 * P0 rail is the CPI stale-red scan, fed by assessAllIntegrationSilence /
 * assessAllQueueFreeze / assessAllHeartbeat. GA4's equivalent row has fired 96
 * times since May into that void. So the real escalation here is the
 * `bing-liveness` heartbeat probe (src/lib/heartbeat.ts), which reads the
 * freshest GREEN row in this log: no green check inside the window is a RED
 * that reaches John through the OPE-75 digest.
 */
export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as BingEnv;
  const now = new Date();

  // A ping that throws IS the signal — capture it rather than 500ing, so a
  // Bing outage produces a row and a streak instead of a silent cron failure.
  let maxDataDate: string | null = null;
  let reachable = true;
  let error: string | null = null;
  try {
    const rows = await getCrawlStats(env, { skipCache: true });
    const dates = rows.map((r) => r.date).filter((d): d is string => Boolean(d));
    // Lexical max is the calendar max for zero-padded YYYY-MM-DD. Seeded with
    // "" so the reduce is empty-safe by construction (FAM-EMPTY-COLLECTION).
    const newest = dates.reduce((a, b) => (a > b ? a : b), "");
    maxDataDate = newest || null;
  } catch (e) {
    reachable = false;
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  const { status, dataAgeSeconds } = classifyBingLiveness({ maxDataDate, reachable, now });

  const [prev] = await db
    .select({ consecutiveFailures: bingLivenessLog.consecutiveFailures })
    .from(bingLivenessLog)
    .orderBy(desc(bingLivenessLog.id))
    .limit(1);
  const consecutiveFailures = nextConsecutiveFailures(prev?.consecutiveFailures ?? 0, status);
  const alertFired = shouldAlertOnStreak(consecutiveFailures);

  await db.insert(bingLivenessLog).values({
    checkedAt: now,
    status,
    maxDataDate,
    dataAgeSeconds,
    consecutiveFailures,
    alertFired: alertFired ? 1 : 0,
    error,
  });

  if (alertFired) {
    await db.insert(adminActions).values({
      action: "bing.liveness_alert",
      actorUserId: null,
      targetType: "bing",
      targetId: "liveness",
      payloadJson: JSON.stringify({
        status,
        maxDataDate,
        dataAgeSeconds,
        consecutiveFailures,
        error,
      }),
      createdAt: now,
    });
  }

  return NextResponse.json({
    success: true,
    status,
    maxDataDate,
    dataAgeSeconds,
    consecutiveFailures,
    alertFired,
    reachable,
    error,
  });
}

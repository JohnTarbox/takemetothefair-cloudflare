import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, ga4LivenessLog } from "@/lib/db/schema";
import { getMaxGa4DateWithUsers, type Ga4Env } from "@/lib/ga4";

export const runtime = "edge";

const DEGRADED_THRESHOLD_SECONDS = 24 * 3600; // 24h → degraded
const CRITICAL_THRESHOLD_SECONDS = 48 * 3600; // 48h → critical
const ALERT_AFTER_CONSECUTIVE = 2;

/**
 * §6.3 Phase 2 GA4 liveness check.
 *
 * Triggered daily by the MCP-Worker cron (06:00 UTC). Pings GA4 for the
 * most recent date with users > 0. Classifies green/degraded/critical by
 * data age. Carries forward `consecutiveFailures` across checks. After
 * 2 consecutive non-green fires, writes `admin_actions.ga4.liveness_alert`
 * which surfaces as a P0 entry in the action queue.
 *
 * Belt-and-suspenders alongside the STALE state in the threshold model:
 * STALE catches the issue at the per-KPI level on every *\/10 fire; this
 * fires once daily as an audit-log signal. Both would have caught the
 * 2026-04-27 → 2026-05-05 silent outage within 48h instead of 8 days.
 */
export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as Ga4Env;

  const maxDate = await getMaxGa4DateWithUsers(env);
  const now = new Date();
  const ageSeconds = computeAgeSeconds(maxDate);

  let status: "green" | "degraded" | "critical";
  if (ageSeconds == null || ageSeconds > CRITICAL_THRESHOLD_SECONDS) {
    status = "critical";
  } else if (ageSeconds > DEGRADED_THRESHOLD_SECONDS) {
    status = "degraded";
  } else {
    status = "green";
  }

  // Carry forward consecutive-failure count from the previous row. Green
  // resets it; non-green increments.
  const [prev] = await db
    .select({ consecutiveFailures: ga4LivenessLog.consecutiveFailures })
    .from(ga4LivenessLog)
    .orderBy(desc(ga4LivenessLog.id))
    .limit(1);
  const consecutiveFailures = status === "green" ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const shouldAlert = consecutiveFailures >= ALERT_AFTER_CONSECUTIVE;

  // Insert log row first; if alert needed, audit row is paired in same
  // transactional block (D1 doesn't support multi-statement transactions
  // without batch, but consecutive INSERTs are cheap and idempotent here).
  await db.insert(ga4LivenessLog).values({
    checkedAt: now,
    status,
    maxDataDate: maxDate,
    dataAgeSeconds: ageSeconds,
    consecutiveFailures,
    alertFired: shouldAlert ? 1 : 0,
  });

  if (shouldAlert) {
    await db.insert(adminActions).values({
      action: "ga4.liveness_alert",
      actorUserId: null,
      targetType: "ga4",
      targetId: "liveness",
      payloadJson: JSON.stringify({
        status,
        maxDataDate: maxDate,
        dataAgeSeconds: ageSeconds,
        consecutiveFailures,
      }),
      createdAt: now,
    });
  }

  return NextResponse.json({
    success: true,
    status,
    maxDataDate: maxDate,
    dataAgeSeconds: ageSeconds,
    consecutiveFailures,
    alertFired: shouldAlert,
  });
}

function computeAgeSeconds(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

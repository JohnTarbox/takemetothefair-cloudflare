export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions, ga4LivenessLog } from "@/lib/db/schema";
import { getMaxGa4DateWithUsers, type Ga4Env } from "@/lib/ga4";
import { computeAgeSeconds } from "@/lib/ga4-liveness";

const DEGRADED_THRESHOLD_SECONDS = 24 * 3600; // 24h → degraded
const CRITICAL_THRESHOLD_SECONDS = 48 * 3600; // 48h → critical
const ALERT_AFTER_CONSECUTIVE = 2;

/**
 * §6.3 Phase 2 GA4 liveness check.
 *
 * Triggered daily by the MCP-Worker cron (06:00 UTC). Pings GA4 for the
 * most recent date with users > 0. Classifies green/degraded/critical by
 * data age. Carries forward `consecutiveFailures` across checks. After
 * 2 consecutive non-green fires, writes `admin_actions.ga4.liveness_alert`.
 *
 * That row is an AUDIT TRAIL, not an alarm — correcting a claim this comment
 * used to make ("surfaces as a P0 entry in the action queue"). Nothing in this
 * codebase reads `admin_actions` as an alert channel: its only consumer is
 * `loadThisWeeksActions`, a 20-row activity card. The operator-facing P0 rail
 * is the CPI stale-red scan, fed by assessAllIntegrationSilence /
 * assessAllQueueFreeze / assessAllHeartbeat. So all 96 alerts this check has
 * fired reached no one. Giving it a heartbeat probe is filed separately.
 *
 * Belt-and-suspenders alongside the STALE state in the threshold model:
 * STALE catches the issue at the per-KPI level on every *\/10 fire; this
 * fires once daily as an audit-log signal. Both would have caught the
 * 2026-04-27 → 2026-05-05 silent outage within 48h instead of 8 days.
 *
 * ── 2026-08-12: this check could not return green, and never had ──
 *
 * Measured in production: `ga4_liveness_log` held 97 rows spanning
 * 2026-05-06 → 2026-08-12 and EVERY ONE was `degraded`, with
 * `data_age_seconds` = 30.0h on every single row. `consecutive_failures`
 * had reached 97 and `ga4.liveness_alert` had fired 96 times.
 *
 * GA4 was healthy the whole time. The check runs at 06:00Z, GA4's freshest
 * complete day is "yesterday", and the age was anchored at MIDNIGHT of that
 * date — so the smallest age it could ever observe was 30h, compared against
 * a 24h `degraded` threshold. Green was unreachable by construction, which
 * made this an alarm that could only ever cry wolf.
 *
 * Fixed by anchoring at the END of the data day (see `computeAgeSeconds`).
 * The thresholds below are unchanged; they now mean what they always said:
 *
 *   healthy (data = yesterday, checked 06:00Z)  ->   6h  -> green
 *   one day missing                             ->  30h  -> degraded
 *   two days missing                            ->  54h  -> critical
 *
 * A note for whoever reads the table: the 97 historical `degraded` rows are
 * left in place as the record of the defect. The streak self-heals — the
 * first green check resets `consecutive_failures` to 0.
 *
 * Found while building the Bing analogue (OPE-309 A5), which deliberately did
 * NOT copy this bug. The escalation path is a separate problem, filed
 * separately: nothing in this codebase reads `admin_actions` as an alert
 * channel, so all 96 of those alerts reached no one.
 */
export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const db = getCloudflareDb();
  const env = getCloudflareEnv() as unknown as Ga4Env;

  const maxDate = await getMaxGa4DateWithUsers(env);
  const now = new Date();
  // Pass the same `now` the row is stamped with, so the logged age and the
  // logged checked_at can never disagree.
  const ageSeconds = computeAgeSeconds(maxDate, now);

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

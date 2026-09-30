export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { agentHeartbeats } from "@/lib/db/schema";
import { logError } from "@/lib/logger";
import { getBurstLimiter } from "@/lib/rate-limit";
import { BURST_SELFTEST_AGENT_CODE, runBurstSelfTest } from "@/lib/burst-selftest";

/**
 * POST /api/internal/burst-selftest  (OPE-951)
 *
 * Drives the production burst cap to a refusal on a throwaway key and stamps
 * `agent_heartbeats` ONLY on a pass. Called once a day by the MCP Worker's
 * daily cron (`burst-cap-selftest-canary.ts`). See `src/lib/burst-selftest.ts`
 * for why this exists: the previous cap was inert in production for its whole
 * life while every test of it passed.
 *
 * The key is random per run, so the self-test never shares a bucket with a
 * real caller, and each run gets a fresh Durable Object whose storage is
 * deleted by its own alarm when the window closes.
 *
 * Auth: X-Internal-Key.
 */
export const POST = withInternalKey({ source: "burst-selftest" }, async ({ db }) => {
  const key = `selftest:${crypto.randomUUID()}`;
  const result = await runBurstSelfTest(getBurstLimiter(), key);

  if (!result.pass) {
    await logError(db, {
      level: "error",
      source: "burst-selftest",
      message: `burst cap self-test FAILED: ${result.reason}`,
      context: { ...result },
    });
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  const now = new Date();
  const note = `pass successes=${result.successes.map((s) => (s ? "T" : "F")).join("")} retryAfter=${result.refusalRetryAfterSeconds}`;
  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: BURST_SELFTEST_AGENT_CODE,
        kind: "watchdog",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "watchdog", note },
      });
  } catch (error) {
    await logError(db, {
      level: "error",
      source: "burst-selftest",
      message: "burst cap self-test passed but the heartbeat stamp failed",
      error,
    });
    return NextResponse.json({ ok: false, ...result, error: "stamp_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...result, stampedAt: now.toISOString() });
});

export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withInternalKey } from "@/lib/api/with-auth";
import { agentHeartbeats } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

/**
 * POST /api/internal/funnel-canary  (OPE-363)
 *
 * The synthetic funnel canary reports here after EVERY run, pass or fail.
 *
 * ── Why a stamp at all, when the CI job already goes red ────────────────────
 * A red CI job says "the canary ran and failed". It cannot say "the canary
 * stopped running" — a deleted schedule, an expired token, or a disabled
 * workflow all look exactly like a healthy week of green. That is the failure
 * the 2026-08-05→09 quota outage taught: every dead-man check we had ran on the
 * thing it was watching. So the canary stamps a row on every run, and a
 * heartbeat probe (`funnel-canary`, see src/lib/heartbeat.ts) reds the OPE-75
 * digest when that row goes stale. Job-red catches a broken funnel; probe-stale
 * catches a broken canary.
 *
 * ── Why `kind` is forced, same as agent-heartbeat ───────────────────────────
 * Written as kind='canary', never caller-supplied. The agent-silence watchdog
 * filters on kind='agent'; a caller able to choose its own kind could stamp
 * kind='agent' and keep that alarm looking fresh while the agent layer was
 * dead. One shared table, so the same guard has to hold here.
 *
 * A FAILING run additionally writes an error-level log, which is what carries
 * it into the existing fault/alert rail — the endpoint does not invent a second
 * alerting mechanism.
 *
 * Auth: X-Internal-Key.
 */
const HEARTBEAT_CODE = "canary:funnel";

const bodySchema = z.object({
  ok: z.boolean(),
  /** Which browser profile produced this result, e.g. "mobile-safari". */
  profile: z.string().min(1).max(64),
  /** Human-readable failure list; empty on a pass. Bounded — this is a note. */
  failures: z.array(z.string().max(200)).max(20).optional(),
  /** Total assertions/checks attempted, for "3/3 passed" style notes. */
  checks: z.number().int().min(0).max(1000).optional(),
});

export const POST = withInternalKey({ source: "funnel-canary" }, async ({ request, db }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  const { ok, profile, failures = [], checks } = parsed.data;
  const now = new Date();

  // The note is the at-a-glance answer in the heartbeat tile, so it leads with
  // the verdict and names the first failure rather than only counting them.
  const note = ok
    ? `pass ${profile}${checks !== undefined ? ` (${checks} checks)` : ""}`
    : `FAIL ${profile}: ${failures.slice(0, 3).join(" | ")}`.slice(0, 500);

  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode: HEARTBEAT_CODE,
        kind: "canary",
        lastSeenAt: now,
        note,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        // Stamped on FAILURE too, deliberately. If only passes stamped, a
        // permanently-broken funnel would read as a stopped canary and get the
        // wrong diagnosis — and the probe would fire for the wrong reason.
        set: { lastSeenAt: now, kind: "canary", note },
      });
  } catch (error) {
    await logError(db, {
      level: "error",
      source: "funnel-canary",
      message: "failed to stamp funnel canary result",
      error,
    });
    return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
  }

  if (!ok) {
    // The alarm itself. Error-level so it reaches the existing fault rail; the
    // canary does not build a parallel notification path.
    await logError(db, {
      level: "error",
      source: "funnel-canary",
      message: `funnel canary FAILED on ${profile}: ${failures.length} check(s) unusable`,
      context: { profile, failures: failures.slice(0, 20), checks },
    });
  }

  return NextResponse.json({ ok: true, recorded: note, at: now.toISOString() });
});

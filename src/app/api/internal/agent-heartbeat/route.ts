export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withInternalKey } from "@/lib/api/with-auth";
import { agentHeartbeats } from "@/lib/db/schema";
import { logError } from "@/lib/logger";

/**
 * POST /api/internal/agent-heartbeat  (OPE-348)
 *
 * One row per agent code, updated in place — we only ever ask "how long since
 * this agent was last alive?", so history would be cost without a consumer.
 *
 * `kind` is forced to 'agent' here and is deliberately NOT caller-supplied. The
 * watchdog's freshness query filters to kind='agent', so a caller able to write
 * kind='watchdog' could silence the alarm by keeping the table looking fresh.
 *
 * Auth: X-Internal-Key.
 */
const bodySchema = z.object({
  agentCode: z.string().min(1).max(64),
  note: z.string().max(500).optional(),
});

export const POST = withInternalKey({ source: "agent-heartbeat" }, async ({ request, db }) => {
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

  const { agentCode, note } = parsed.data;
  const now = new Date();
  try {
    await db
      .insert(agentHeartbeats)
      .values({
        id: crypto.randomUUID(),
        agentCode,
        kind: "agent",
        lastSeenAt: now,
        note: note ?? null,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentCode,
        set: { lastSeenAt: now, kind: "agent", note: note ?? null },
      });
  } catch (error) {
    await logError(db, {
      level: "error",
      source: "agent-heartbeat",
      message: `failed to stamp heartbeat for ${agentCode}`,
      error,
    });
    return NextResponse.json({ ok: false, error: "write_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, agentCode, lastSeenAt: now.toISOString() });
});

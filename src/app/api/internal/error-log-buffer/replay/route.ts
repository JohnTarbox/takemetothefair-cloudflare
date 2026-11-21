export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withInternalKey } from "@/lib/api/with-auth";
import { getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { agentHeartbeats, errorLogs } from "@/lib/db/schema";
import {
  REPLAY_HEARTBEAT_CODE,
  replayBufferedErrorLogs,
} from "@/lib/observability/error-log-buffer";

/**
 * POST /api/internal/error-log-buffer/replay (OPE-1664)
 *
 * Drains the KV buffer of `error_logs` rows whose D1 insert failed (see
 * src/lib/observability/error-log-buffer.ts) back into `error_logs`, keeping
 * each row's id and timestamp and marking `context.replayedFromBuffer`. Called
 * by the MCP Worker's `*\/10` cron. Auth: X-Internal-Key.
 *
 * Writes the `watchdog:error-log-buffer-replay` heartbeat only when the drain
 * completed (an empty buffer included). A drain that stopped because D1 refused
 * a write, or that threw, writes no stamp, so the probe goes silent while the
 * replay cannot run.
 *
 * It deliberately does NOT call logError on failure: during an outage that
 * would buffer a row about failing to replay the buffer, every 10 minutes.
 */
export const POST = withInternalKey({ source: "error-log-buffer:replay" }, async ({ db }) => {
  const kv = getCloudflareRateLimitKv();
  if (!kv) {
    return NextResponse.json({ ok: false, error: "RATE_LIMIT_KV not bound" }, { status: 503 });
  }
  try {
    const result = await replayBufferedErrorLogs(kv, async (row) => {
      const inserted = await db
        .insert(errorLogs)
        .values(row as typeof errorLogs.$inferInsert)
        .onConflictDoNothing({ target: errorLogs.id })
        .returning({ id: errorLogs.id });
      return inserted.length > 0;
    });
    if (!result.stoppedOnError) {
      const now = new Date();
      const note = `replayed=${result.replayed} present=${result.alreadyPresent} more=${result.more}`;
      await db
        .insert(agentHeartbeats)
        .values({
          id: crypto.randomUUID(),
          agentCode: REPLAY_HEARTBEAT_CODE,
          kind: "watchdog",
          lastSeenAt: now,
          note,
        })
        .onConflictDoUpdate({
          target: agentHeartbeats.agentCode,
          set: { lastSeenAt: now, note },
        });
    }
    return NextResponse.json({ ok: !result.stoppedOnError, ...result });
  } catch (e) {
    console.error("[error-log-buffer] replay failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
});

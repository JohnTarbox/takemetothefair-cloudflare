export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { pruneKpiStateHistory, recomputeKpiStates } from "@/lib/kpi-states";

/**
 * §6.3 KPI state-machine recompute endpoint.
 *
 * Triggered every 10 minutes by the MCP-Worker cron (mcp-server/wrangler.toml
 * crons = ["*\/10 * * * *", ...]) which POSTs here with X-Internal-Key. Reads
 * the 5 executive KPIs against the 48h-stable window, classifies each, and
 * appends rows to kpi_state_history. Then prunes >90d.
 *
 * Idempotent for the most part — running it twice in the same minute writes
 * two rows per KPI but doesn't cause harm. Cost is bounded (5 KPI loaders +
 * one INSERT batch + one DELETE).
 */
export async function POST(request: Request) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const db = getCloudflareDb();
  const env = getCloudflareEnv();

  // OPE-1650 — a failure answers with a classified body, not an empty 500, so
  // the cron's log row says what broke instead of guessing a resource kill.
  let stage: "recompute" | "prune" = "recompute";
  let recomputed: Awaited<ReturnType<typeof recomputeKpiStates>>;
  let pruned: Awaited<ReturnType<typeof pruneKpiStateHistory>>;
  try {
    recomputed = await recomputeKpiStates(db, env);
    stage = "prune";
    pruned = await pruneKpiStateHistory(db);
  } catch (e) {
    // Duck-typed: the abort is a DOMException, which is not `instanceof Error`
    // in every runtime, and its name is the classification that matters.
    const o = (typeof e === "object" && e !== null ? e : {}) as {
      name?: unknown;
      message?: unknown;
    };
    const name = typeof o.name === "string" ? o.name : "Error";
    const message = typeof o.message === "string" ? o.message : String(e);
    console.error(`[kpi-recompute] ${stage} failed: ${name}: ${message}`, e);
    return NextResponse.json(
      {
        success: false,
        stage,
        error: name,
        message: message.slice(0, 300),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    written: recomputed.written,
    transitions: recomputed.transitions,
    resolved: recomputed.resolved,
    pruned: pruned.deleted,
  });
}

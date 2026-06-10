export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { pruneKpiStateHistory, recomputeKpiStates } from "@/lib/kpi-states";
import type { Ga4Env } from "@/lib/ga4";
import type { ScEnv } from "@/lib/search-console";

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
  const env = getCloudflareEnv() as unknown as ScEnv & Ga4Env;

  const recomputed = await recomputeKpiStates(db, env);
  const pruned = await pruneKpiStateHistory(db);

  return NextResponse.json({
    success: true,
    written: recomputed.written,
    transitions: recomputed.transitions,
    resolved: recomputed.resolved,
    pruned: pruned.deleted,
  });
}

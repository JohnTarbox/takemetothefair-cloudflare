export const dynamic = "force-dynamic";
/**
 * Poll the status of a running schema-org-sync Workflow instance.
 *
 * Returns Cloudflare's per-instance status (queued / running / paused /
 * complete / errored / terminated) plus the final output if complete.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const { id } = await params;

  // Pages can't bind the workflow class — proxy through the MCP Worker,
  // which has the binding and an X-Internal-Key-gated status endpoint.
  // See /api/admin/schema-org/sync-workflow/start for the same pattern.
  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (!cfEnv.INTERNAL_API_KEY) {
    return NextResponse.json(
      { error: "internal_misconfigured", message: "INTERNAL_API_KEY missing on Pages env" },
      { status: 503 }
    );
  }

  try {
    const upstream = await fetch(
      `https://mcp.meetmeatthefair.com/api/admin/workflows/schema-org-sync/status/${encodeURIComponent(id)}`,
      { headers: { "x-internal-key": cfEnv.INTERNAL_API_KEY } }
    );
    const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(body, { status: upstream.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: "workflow_proxy_failed",
        message: error instanceof Error ? error.message : "unknown",
      },
      { status: 500 }
    );
  }
}

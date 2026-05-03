/**
 * Poll the status of a running schema-org-sync Workflow instance.
 *
 * Returns Cloudflare's per-instance status (queued / running / paused /
 * complete / errored / terminated) plus the final output if complete.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";

export const runtime = "edge";

interface Params {
  params: Promise<{ id: string }>;
}

type WorkflowInstance = {
  status: () => Promise<{
    status: "queued" | "running" | "paused" | "complete" | "errored" | "terminated" | "waiting";
    output?: unknown;
    error?: { message: string; name: string } | null;
  }>;
};

export async function GET(request: NextRequest, { params }: Params) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const { id } = await params;

  const env = getCloudflareEnv() as unknown as {
    SCHEMA_ORG_SYNC?: { get: (id: string) => Promise<WorkflowInstance> };
  };

  if (!env.SCHEMA_ORG_SYNC) {
    return NextResponse.json({ error: "workflow_unbound" }, { status: 503 });
  }

  try {
    const instance = await env.SCHEMA_ORG_SYNC.get(id);
    const state = await instance.status();
    return NextResponse.json({ workflowId: id, ...state });
  } catch (error) {
    return NextResponse.json(
      {
        error: "workflow_not_found",
        message: error instanceof Error ? error.message : "unknown",
      },
      { status: 404 }
    );
  }
}

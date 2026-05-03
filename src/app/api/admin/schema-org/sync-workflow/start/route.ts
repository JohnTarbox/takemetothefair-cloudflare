/**
 * Trigger the schema-org-sync Workflow.
 *
 * Proof-of-pattern alternative to /api/admin/schema-org/sync. The inline
 * sync caps at 50 events because of Cloudflare's 30s response cap; this
 * Workflow path handles arbitrarily many events durably (each event is its
 * own retried step). For runs of 50+ events, prefer this endpoint.
 *
 * Returns the workflow instance ID so the caller can poll status via
 * GET /api/admin/schema-org/sync-workflow/[id]/status.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { logError } from "@/lib/logger";
import { getCloudflareDb } from "@/lib/cloudflare";

export const runtime = "edge";

const bodySchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(1000),
  delayMs: z.number().int().min(0).max(5000).optional(),
});

export async function POST(request: NextRequest) {
  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.message },
      { status: 400 }
    );
  }

  const env = getCloudflareEnv() as unknown as {
    SCHEMA_ORG_SYNC?: { create: (opts: { params: unknown }) => Promise<{ id: string }> };
  };

  if (!env.SCHEMA_ORG_SYNC) {
    return NextResponse.json(
      {
        error: "workflow_unbound",
        message: "SCHEMA_ORG_SYNC binding missing — local dev or misconfigured",
      },
      { status: 503 }
    );
  }

  try {
    const instance = await env.SCHEMA_ORG_SYNC.create({ params: parsed.data });
    return NextResponse.json({ workflowId: instance.id, eventCount: parsed.data.eventIds.length });
  } catch (error) {
    const db = getCloudflareDb();
    await logError(db, {
      message: "Failed to start schema-org-sync workflow",
      error,
      source: "api/admin/schema-org/sync-workflow/start",
      request,
    });
    return NextResponse.json({ error: "workflow_create_failed" }, { status: 500 });
  }
}

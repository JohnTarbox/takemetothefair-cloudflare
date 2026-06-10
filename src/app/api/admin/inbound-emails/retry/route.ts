export const dynamic = "force-dynamic";
/**
 * POST /api/admin/inbound-emails/retry — retry a failed/stuck inbound
 * email by resetting its status and asking the MCP worker to create a
 * fresh InboundEmailWorkflow instance.
 *
 * Body: `{ messageRowId: string }`.
 *
 * Two cross-service steps:
 *   1. Local UPDATE inbound_emails (clear error/workflowInstanceId,
 *      reset status='received') — done first so the new workflow's
 *      mark-processing step sees a fresh row.
 *   2. POST to the MCP worker's
 *      /api/admin/workflows/inbound-email/start endpoint, which calls
 *      env.INBOUND_EMAIL.create — workflows can only be created from
 *      the worker that hosts the binding.
 *
 * Audit row written via admin_actions.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { inboundEmails, adminActions } from "@/lib/db/schema";
import { eq, inArray, and } from "drizzle-orm";

const RETRYABLE_STATUSES = ["received", "processing", "failed"] as const;
const MCP_URL = "https://mcp.meetmeatthefair.com";

interface RetryBody {
  messageRowId?: unknown;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as RetryBody;
  if (typeof body.messageRowId !== "string" || body.messageRowId.length === 0) {
    return NextResponse.json({ error: "messageRowId required" }, { status: 400 });
  }
  const messageRowId = body.messageRowId;

  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (!cfEnv.INTERNAL_API_KEY) {
    return NextResponse.json(
      { error: "internal_misconfigured", message: "INTERNAL_API_KEY missing on Pages env" },
      { status: 503 }
    );
  }

  const db = getCloudflareDb();

  // Confirm row exists and is in a retryable state, capture intent for
  // the MCP-side workflow create.
  const rows = await db
    .select({ id: inboundEmails.id, intent: inboundEmails.intent, status: inboundEmails.status })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.id, messageRowId),
        inArray(inboundEmails.status, [...RETRYABLE_STATUSES])
      )
    )
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "row not found or not in a retryable status" },
      { status: 404 }
    );
  }
  const { intent, status: prevStatus } = rows[0];

  // Reset state so the new workflow's mark-processing step sees a row
  // that hasn't been touched by the prior instance.
  await db
    .update(inboundEmails)
    .set({ status: "received", workflowInstanceId: null, error: null })
    .where(eq(inboundEmails.id, messageRowId));

  // Ask the MCP worker to create a new workflow instance for this row.
  const startRes = await fetch(`${MCP_URL}/api/admin/workflows/inbound-email/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": cfEnv.INTERNAL_API_KEY,
    },
    body: JSON.stringify({ messageRowId, intent }),
  });
  if (!startRes.ok) {
    const errBody = await startRes.text().catch(() => "");
    return NextResponse.json(
      { error: `MCP start failed: ${startRes.status}`, body: errBody.slice(0, 500) },
      { status: 502 }
    );
  }
  const startData = (await startRes.json().catch(() => ({}))) as { workflowId?: string };

  // Audit
  await db.insert(adminActions).values({
    action: "inbound_email.retry",
    actorUserId: session.user.id,
    targetType: "inbound_email",
    targetId: messageRowId,
    payloadJson: JSON.stringify({
      prevStatus,
      newWorkflowInstanceId: startData.workflowId ?? null,
      intent,
    }),
    createdAt: new Date(),
  });

  return NextResponse.json({
    ok: true,
    messageRowId,
    workflowInstanceId: startData.workflowId ?? null,
  });
}

export const dynamic = "force-dynamic";
/**
 * POST /api/admin/inbound-emails/decide — admin resolves a waiting
 * correction/press inbound email. Proxies to the MCP worker's
 * /api/admin/inbound-emails/:rowId/decide endpoint, which calls
 * `instance.sendEvent({type:"admin-decision", payload})` to resume the
 * paused InboundEmailWorkflow.
 *
 * Body: `{ messageRowId: string, action: "applied"|"rejected"|
 * "needs-more-info", note?: string }`.
 *
 * The actual decision logic (which reply kind, what text) lives in
 * the workflow's decisionToReplyKind + email-reply-builder. This route
 * is a thin proxy with auth + audit.
 */

import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { adminActions } from "@/lib/db/schema";

const MCP_URL = "https://mcp.meetmeatthefair.com";
const VALID_ACTIONS = new Set(["applied", "rejected", "needs-more-info"]);

interface DecideBody {
  messageRowId?: unknown;
  action?: unknown;
  note?: unknown;
}

export const POST = withAuth({ role: "ADMIN" }, async ({ request, db, session }) => {
  const body = (await request.json().catch(() => ({}))) as DecideBody;
  if (typeof body.messageRowId !== "string" || body.messageRowId.length === 0) {
    return NextResponse.json({ error: "messageRowId required" }, { status: 400 });
  }
  if (typeof body.action !== "string" || !VALID_ACTIONS.has(body.action)) {
    return NextResponse.json(
      { error: "action must be one of: applied, rejected, needs-more-info" },
      { status: 400 }
    );
  }
  const note =
    typeof body.note === "string" && body.note.length > 0 ? body.note.slice(0, 500) : undefined;

  const cfEnv = getCloudflareEnv() as unknown as { INTERNAL_API_KEY?: string };
  if (!cfEnv.INTERNAL_API_KEY) {
    return NextResponse.json(
      { error: "internal_misconfigured", message: "INTERNAL_API_KEY missing on Pages env" },
      { status: 503 }
    );
  }

  const upstream = await fetch(
    `${MCP_URL}/api/admin/inbound-emails/${encodeURIComponent(body.messageRowId)}/decide`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": cfEnv.INTERNAL_API_KEY,
      },
      body: JSON.stringify({ action: body.action, note }),
    }
  );
  const upstreamBody = (await upstream.json().catch(() => ({}))) as { error?: string };
  if (!upstream.ok) {
    return NextResponse.json(
      { error: upstreamBody.error ?? `MCP returned ${upstream.status}` },
      { status: upstream.status }
    );
  }

  // Audit
  await db.insert(adminActions).values({
    action: "inbound_email.decide",
    actorUserId: session.user.id,
    targetType: "inbound_email",
    targetId: body.messageRowId,
    payloadJson: JSON.stringify({ action: body.action, note: note ?? null }),
    createdAt: new Date(),
  });

  return NextResponse.json({ ok: true });
});

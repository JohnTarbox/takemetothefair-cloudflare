/**
 * GET /api/admin/inbound-emails — list recent inbound emails for the
 * /admin/inbound-emails DLQ view.
 *
 * Filters via query string:
 *   - status: comma-separated subset of received|processing|replied|forwarded|failed
 *   - intent: single value (submit|correction|...)
 *   - sinceHours: cutoff window (default 168 = 7 days)
 *   - limit: cap, max 500
 *
 * The page itself is at src/app/admin/inbound-emails/page.tsx.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails } from "@/lib/db/schema";
import { desc, eq, gte, inArray, and, type SQL } from "drizzle-orm";

export const runtime = "edge";

const ALLOWED_STATUSES = ["received", "processing", "replied", "forwarded", "failed"] as const;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const statusParam = params.get("status");
  const intent = params.get("intent");
  const sinceHours = Math.min(Math.max(parseInt(params.get("sinceHours") || "168", 10), 1), 720);
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "200", 10), 1), 500);

  const conditions: SQL[] = [];
  const cutoff = new Date(Date.now() - sinceHours * 3600 * 1000);
  conditions.push(gte(inboundEmails.receivedAt, cutoff));
  if (statusParam) {
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof ALLOWED_STATUSES)[number] =>
        (ALLOWED_STATUSES as readonly string[]).includes(s)
      );
    if (statuses.length > 0) {
      conditions.push(inArray(inboundEmails.status, statuses));
    }
  }
  if (intent) {
    conditions.push(eq(inboundEmails.intent, intent));
  }

  const db = getCloudflareDb();
  const rows = await db
    .select({
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      fromAddress: inboundEmails.fromAddress,
      toAddress: inboundEmails.toAddress,
      subject: inboundEmails.subject,
      intent: inboundEmails.intent,
      status: inboundEmails.status,
      workflowInstanceId: inboundEmails.workflowInstanceId,
      error: inboundEmails.error,
      parsedUrl: inboundEmails.parsedUrl,
      attachmentCount: inboundEmails.attachmentCount,
    })
    .from(inboundEmails)
    .where(and(...conditions))
    .orderBy(desc(inboundEmails.receivedAt))
    .limit(limit);

  return NextResponse.json(
    rows.map((r) => ({
      ...r,
      receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : r.receivedAt,
    }))
  );
}

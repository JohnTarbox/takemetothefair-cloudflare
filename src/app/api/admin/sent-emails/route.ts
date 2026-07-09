export const dynamic = "force-dynamic";
/**
 * OPE-152 — GET /api/admin/sent-emails. The outbound counterpart to
 * /api/admin/inbound-emails: lists email_send_ledger (populated by OPE-151) so
 * an admin can see every send — auto-replies, claim invites, vendor outreach,
 * system notices, main-app transactional — including FAILURES.
 *
 * Filters (query string):
 *   - q:          recipient substring (address search)
 *   - status:     comma-separated subset of sent|failed|stubbed
 *   - source:     exact source/kind match (e.g. reply:support-ack, registration)
 *   - inboundEmailId: only sends triggered by this inbound email (threading)
 *   - sinceHours: cutoff window (default 720 = 30d, max 8760 = 1y retention)
 *   - limit:      cap, max 500
 *
 * Rows triggered by an inbound email are decorated with that inbound's
 * from/subject so the thread is legible. Admin-gated (PII: recipients + subjects).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { emailSendLedger, inboundEmails } from "@/lib/db/schema";
import { and, desc, eq, gte, inArray, like, type SQL } from "drizzle-orm";

const ALLOWED_STATUSES = ["sent", "failed", "stubbed"] as const;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim();
  const statusParam = params.get("status");
  const source = params.get("source")?.trim();
  const inboundEmailId = params.get("inboundEmailId")?.trim();
  const sinceHours = Math.min(Math.max(parseInt(params.get("sinceHours") || "720", 10), 1), 8760);
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "200", 10), 1), 500);

  const conditions: SQL[] = [
    gte(emailSendLedger.sentAt, new Date(Date.now() - sinceHours * 3600_000)),
  ];
  if (q) conditions.push(like(emailSendLedger.recipient, `%${q}%`));
  if (source) conditions.push(eq(emailSendLedger.source, source));
  if (inboundEmailId) conditions.push(eq(emailSendLedger.inboundEmailId, inboundEmailId));
  if (statusParam) {
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is (typeof ALLOWED_STATUSES)[number] =>
        (ALLOWED_STATUSES as readonly string[]).includes(s)
      );
    if (statuses.length > 0) conditions.push(inArray(emailSendLedger.status, statuses));
  }

  const db = getCloudflareDb();
  const rows = await db
    .select({
      messageId: emailSendLedger.messageId,
      sentAt: emailSendLedger.sentAt,
      recipient: emailSendLedger.recipient,
      source: emailSendLedger.source,
      subject: emailSendLedger.subject,
      status: emailSendLedger.status,
      provider: emailSendLedger.provider,
      providerMessageId: emailSendLedger.providerMessageId,
      error: emailSendLedger.error,
      inboundEmailId: emailSendLedger.inboundEmailId,
    })
    .from(emailSendLedger)
    .where(and(...conditions))
    .orderBy(desc(emailSendLedger.sentAt))
    .limit(limit);

  // Decorate the auto-reply rows with their triggering inbound (threading).
  const inboundIds = Array.from(
    new Set(rows.map((r) => r.inboundEmailId).filter((id): id is string => typeof id === "string"))
  );
  const inboundById = new Map<string, { fromAddress: string; subject: string | null }>();
  const BATCH = 50; // stay under D1's ~100 bound-param cap
  for (let i = 0; i < inboundIds.length; i += BATCH) {
    const inbRows = await db
      .select({
        id: inboundEmails.id,
        fromAddress: inboundEmails.fromAddress,
        subject: inboundEmails.subject,
      })
      .from(inboundEmails)
      .where(inArray(inboundEmails.id, inboundIds.slice(i, i + BATCH)));
    for (const r of inbRows)
      inboundById.set(r.id, { fromAddress: r.fromAddress, subject: r.subject });
  }

  return NextResponse.json(
    rows.map((r) => ({
      ...r,
      sentAt: r.sentAt instanceof Date ? r.sentAt.toISOString() : r.sentAt,
      inbound: r.inboundEmailId ? (inboundById.get(r.inboundEmailId) ?? null) : null,
    }))
  );
}

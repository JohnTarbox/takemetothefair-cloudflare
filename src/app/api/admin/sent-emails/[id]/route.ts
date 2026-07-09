export const dynamic = "force-dynamic";
/**
 * OPE-155 — GET /api/admin/sent-emails/[id]: full detail of one ledgered send,
 * including the rendered body_html / body_text (OPE-155) that actually went out.
 * Split from the list endpoint so the list stays lean (bodies fetched on demand
 * when a row is expanded). Admin-gated (PII: full message body at rest).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { emailSendLedger } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const db = getCloudflareDb();
  const [row] = await db
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
      bodyHtml: emailSendLedger.bodyHtml,
      bodyText: emailSendLedger.bodyText,
    })
    .from(emailSendLedger)
    .where(eq(emailSendLedger.messageId, id))
    .limit(1);

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ...row,
    sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : row.sentAt,
  });
}

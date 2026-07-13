export const dynamic = "force-dynamic";
/**
 * OPE-156 — GET /api/admin/inbound-emails/[id]: full detail of one received
 * email, including the full parsed body_text / body_html (OPE-156) captured at
 * ingest. Split from the list endpoint so the list stays lean (bodies fetched
 * on demand when a row is expanded). Admin-gated (PII: full message body at
 * rest). Rows predating OPE-156 have null body_text/body_html and the caller
 * falls back to body_text_excerpt with an "excerpt only" indicator.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails } from "@/lib/db/schema";
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
      id: inboundEmails.id,
      receivedAt: inboundEmails.receivedAt,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      bodyText: inboundEmails.bodyText,
      bodyHtml: inboundEmails.bodyHtml,
      bodyTextExcerpt: inboundEmails.bodyTextExcerpt,
      rawSize: inboundEmails.rawSize,
      // OPE-187 — JSON [{key,name,mimeType,size}] so the detail panel can render
      // each poster/flyer (previewed + downloaded via the authed attachments route).
      attachmentRefs: inboundEmails.attachmentRefs,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .limit(1);

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    ...row,
    receivedAt: row.receivedAt instanceof Date ? row.receivedAt.toISOString() : row.receivedAt,
  });
}

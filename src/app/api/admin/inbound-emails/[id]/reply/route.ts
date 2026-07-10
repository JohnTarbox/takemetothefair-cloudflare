export const dynamic = "force-dynamic";
/**
 * OPE-163 — POST /api/admin/inbound-emails/[id]/reply: send a reply to a
 * received email, addressed to the original sender, from
 * support@meetmeatthefair.com. Powers the /admin/inbound-emails compose panel.
 * Works for ANY sender (not vendor-scoped). Reuses the transactional
 * enqueueEmail path (OPE-163 Part 1): the MCP consumer sends + ledgers +
 * threads, so the reply logs to email_send_ledger with the inbound_email_id
 * link. Marks the inbound status='replied', reply_kind='manual'.
 *
 * Gated: this endpoint refuses to enqueue unless EMAIL_REPLY_ENABLED === "true"
 * (immediate operator feedback). The consumer enforces the same flag as the
 * authoritative hard stop (OPE-6 customer-facing send path).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { inboundEmails, emailSuppressionList, adminActions } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/queues/producers";
import { eq } from "drizzle-orm";

const REPLY_FROM = "Meet Me at the Fair <support@meetmeatthefair.com>";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function textToHtml(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

type Body = { body?: unknown; subject?: unknown; html?: unknown };

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  if (env.EMAIL_REPLY_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "reply_disabled",
        message:
          "Reply sending is disabled (EMAIL_REPLY_ENABLED != 'true'). Nothing was sent. An operator must enable it before replies can go out.",
      },
      { status: 409 }
    );
  }

  const { id } = await params;
  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const bodyText = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!bodyText) {
    return NextResponse.json(
      { error: "missing_body", message: "A non-empty `body` is required." },
      { status: 400 }
    );
  }
  const subjectOverride = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const htmlOverride = typeof payload.html === "string" ? payload.html.trim() : "";

  const db = getCloudflareDb();
  const [row] = await db
    .select({
      id: inboundEmails.id,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.subject,
      messageId: inboundEmails.messageId,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Suppression safety net — never email an opted-out address.
  const [suppressed] = await db
    .select({ email: emailSuppressionList.email })
    .from(emailSuppressionList)
    .where(eq(emailSuppressionList.email, row.fromAddress.trim().toLowerCase()))
    .limit(1);
  if (suppressed) {
    return NextResponse.json(
      {
        error: "suppressed",
        message: `${row.fromAddress} is on the suppression list (unsubscribed). Nothing was sent.`,
      },
      { status: 409 }
    );
  }

  const subject = (subjectOverride || `Re: ${row.subject || "your message"}`).slice(0, 200);
  const html = htmlOverride || textToHtml(bodyText);

  await enqueueEmail({
    to: row.fromAddress,
    subject,
    text: bodyText,
    html,
    from: REPLY_FROM,
    source: "reply:manual",
    inboundEmailId: row.id,
    ...(row.messageId ? { inReplyTo: row.messageId, references: row.messageId } : {}),
  });

  // Optimistic — the ledger row the consumer writes is the delivery source of truth.
  await db
    .update(inboundEmails)
    .set({ status: "replied", replyKind: "manual" })
    .where(eq(inboundEmails.id, row.id));

  await db.insert(adminActions).values({
    action: "inbound.reply_sent",
    actorUserId: session.user.id,
    targetType: "inbound_email",
    targetId: row.id,
    payloadJson: JSON.stringify({ to: row.fromAddress, subject, via: "admin-ui" }),
    createdAt: new Date(),
  });

  return NextResponse.json({
    success: true,
    queued: true,
    inbound_email_id: row.id,
    to: row.fromAddress,
    subject,
    from: REPLY_FROM,
  });
}

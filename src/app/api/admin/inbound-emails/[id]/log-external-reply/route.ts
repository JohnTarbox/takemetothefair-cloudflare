export const dynamic = "force-dynamic";
/**
 * OPE-178 — POST /api/admin/inbound-emails/[id]/log-external-reply: record an
 * email that was ALREADY sent outside the platform (e.g. from John's Gmail) into
 * email_send_ledger, threaded to the inbound message it responds to. Complements
 * OPE-163 (reply-from-server = send + log); this is **log-only** — it never
 * sends any email. Admin-gated; no STOP-gate (records a row only).
 *
 * The row is distinguishable from platform sends: source `manual:external`,
 * caller-supplied provider (default `external`, e.g. `gmail`). Marks the inbound
 * status='replied', reply_kind='external'.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { inboundEmails, emailSendLedger, adminActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const SOURCE = "manual:external";

type Body = {
  recipient?: unknown;
  subject?: unknown;
  body?: unknown;
  html?: unknown;
  sent_at?: unknown;
  provider?: unknown;
  provider_message_id?: unknown;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const recipient = typeof payload.recipient === "string" ? payload.recipient.trim() : "";
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const bodyText = typeof payload.body === "string" ? payload.body : "";
  const bodyHtml = typeof payload.html === "string" && payload.html.trim() ? payload.html : null;
  const provider =
    typeof payload.provider === "string" && payload.provider.trim()
      ? payload.provider.trim().slice(0, 40)
      : "external";
  const providerMessageId =
    typeof payload.provider_message_id === "string" && payload.provider_message_id.trim()
      ? payload.provider_message_id.trim()
      : null;
  if (!recipient || !bodyText) {
    return NextResponse.json(
      { error: "missing_fields", message: "`recipient` and `body` are required." },
      { status: 400 }
    );
  }

  // Parse the operator-supplied sent time; fall back to now on a bad/empty value.
  let sentAt = new Date();
  if (typeof payload.sent_at === "string" && payload.sent_at.trim()) {
    const parsed = new Date(payload.sent_at);
    if (!Number.isNaN(parsed.getTime())) sentAt = parsed;
  }

  const db = getCloudflareDb();

  // Confirm the inbound row exists so we don't orphan-link.
  const [inbound] = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, id))
    .limit(1);
  if (!inbound) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const messageId = `external-${crypto.randomUUID()}`;
  await db.insert(emailSendLedger).values({
    messageId,
    sentAt,
    recipient,
    source: SOURCE,
    subject: subject || null,
    status: "sent",
    provider,
    providerMessageId,
    inboundEmailId: id,
    bodyHtml,
    bodyText,
    error: null,
  });

  // Thread it: mark the inbound replied (externally).
  await db
    .update(inboundEmails)
    .set({ status: "replied", replyKind: "external" })
    .where(eq(inboundEmails.id, id));

  await db.insert(adminActions).values({
    action: "inbound.external_reply_logged",
    actorUserId: session.user.id,
    targetType: "inbound_email",
    targetId: id,
    payloadJson: JSON.stringify({ recipient, subject, provider, messageId }),
    createdAt: new Date(),
  });

  return NextResponse.json({
    success: true,
    message_id: messageId,
    inbound_email_id: id,
    recipient,
    provider,
  });
}

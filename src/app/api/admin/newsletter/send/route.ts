export const dynamic = "force-dynamic";
/**
 * OPE-169 — newsletter broadcast send. Admin-gated. Renders a digest and sends
 * it to the confirmed, non-unsubscribed, non-suppressed subscriber list via the
 * transactional pipeline (each send ledgered by the consumer, source
 * `newsletter:weekly-digest`). Creates/updates the public `newsletter_issues`
 * record so the issue has a web page + view-in-browser URL (OPE-170).
 *
 * Two modes:
 *  - `test_recipient` set → sends ONLY to that address (for verification). The
 *    issue record is upserted with sent_at=null (excluded from the public
 *    archive). Allowed regardless of the flag.
 *  - broadcast (no test_recipient) → sends to the whole eligible list. Gated
 *    behind NEWSLETTER_SEND_ENABLED === "true" (OPE-6 customer-facing send).
 *    Sets the issue's sent_at.
 *
 * Body: { subject, content_html, content_text?, test_recipient? }.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { newsletterSubscribers, newsletterIssues, emailSuppressionList } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/queues/producers";
import { newsletterDigestTemplate } from "@/lib/email/templates";
import {
  signUnsubscribeToken,
  resolveUnsubscribeSecret,
} from "@/lib/email/newsletter-unsubscribe-token";
import { getSiteUrl } from "@/lib/email/send";
import { createSlug } from "@takemetothefair/utils";
import { and, eq } from "drizzle-orm";

const SOURCE = "newsletter:weekly-digest";
const FROM = "Meet Me at the Fair <hello@meetmeatthefair.com>";

type Body = {
  subject?: unknown;
  content_html?: unknown;
  content_text?: unknown;
  test_recipient?: unknown;
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const contentHtml = typeof body.content_html === "string" ? body.content_html.trim() : "";
  const contentText = typeof body.content_text === "string" ? body.content_text : undefined;
  const testRecipient =
    typeof body.test_recipient === "string" ? body.test_recipient.trim().toLowerCase() : "";
  if (!subject || !contentHtml) {
    return NextResponse.json(
      { error: "missing_fields", message: "`subject` and `content_html` are required." },
      { status: 400 }
    );
  }

  const isBroadcast = !testRecipient;
  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;

  // OPE-6 gate — a real broadcast to the list needs the flag; a single-address
  // test send is always allowed so the format can be verified.
  if (isBroadcast && env.NEWSLETTER_SEND_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "broadcast_disabled",
        message:
          "Broadcast sending is disabled (NEWSLETTER_SEND_ENABLED != 'true'). Use test_recipient to verify formatting, or enable the flag to broadcast to the list.",
      },
      { status: 409 }
    );
  }

  const secret = resolveUnsubscribeSecret(env);
  if (!secret) {
    return NextResponse.json(
      { error: "no_secret", message: "No unsubscribe signing secret configured." },
      { status: 500 }
    );
  }

  const db = getCloudflareDb();
  const siteUrl = getSiteUrl();
  const now = new Date();

  // Upsert the issue record. sent_at is set only on a real broadcast — a test
  // leaves it null so it's excluded from the public archive but /newsletter/{slug}
  // still resolves for the view-in-browser link.
  const slug = `${createSlug(subject)}-${now.toISOString().slice(0, 10)}`.slice(0, 120);
  await db
    .insert(newsletterIssues)
    .values({ slug, subject, html: contentHtml, sentAt: isBroadcast ? now : null, createdAt: now })
    .onConflictDoUpdate({
      target: newsletterIssues.slug,
      set: { subject, html: contentHtml, ...(isBroadcast ? { sentAt: now } : {}) },
    });
  const viewInBrowserUrl = `${siteUrl}/newsletter/${slug}`;
  const mailingAddress = env.MAILING_ADDRESS;

  // Resolve recipients.
  let recipients: string[];
  if (testRecipient) {
    recipients = [testRecipient];
  } else {
    const subs = await db
      .select({ email: newsletterSubscribers.email })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.confirmed, true),
          eq(newsletterSubscribers.unsubscribed, false)
        )
      );
    const suppressedRows = await db
      .select({ email: emailSuppressionList.email })
      .from(emailSuppressionList);
    const suppressed = new Set(suppressedRows.map((r) => r.email.toLowerCase()));
    recipients = subs.map((s) => s.email).filter((e) => !suppressed.has(e.toLowerCase()));
  }

  // Enqueue one send per recipient (the consumer sends + ledgers). Each carries
  // its own signed unsubscribe URL.
  let queued = 0;
  for (const email of recipients) {
    const token = await signUnsubscribeToken(email, secret);
    const unsubscribeUrl = `${siteUrl}/api/newsletter/unsubscribe?token=${token}`;
    const tpl = newsletterDigestTemplate({
      subject,
      contentHtml,
      contentText,
      unsubscribeUrl,
      viewInBrowserUrl,
      mailingAddress,
    });
    await enqueueEmail({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      from: FROM,
      source: SOURCE,
    });
    queued++;
  }

  return NextResponse.json({
    success: true,
    mode: isBroadcast ? "broadcast" : "test",
    issue_slug: slug,
    view_in_browser: viewInBrowserUrl,
    recipients: queued,
  });
}

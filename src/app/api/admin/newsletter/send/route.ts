export const dynamic = "force-dynamic";
/**
 * OPE-169 — newsletter broadcast send. Admin-gated. Renders a digest and sends
 * it to the confirmed, non-unsubscribed, non-suppressed subscriber list via the
 * transactional pipeline (each send ledgered by the consumer, source
 * `newsletter:weekly-digest`). Creates/updates the public `newsletter_issues`
 * record so the issue has a web page + view-in-browser URL (OPE-170).
 *
 * Three modes:
 *  - `preview_only: true` → READ-ONLY pre-flight. Resolves the recipient list +
 *    the `newsletter_issues` shape that WOULD be written, and returns them
 *    without upserting the issue, enqueueing any mail, or writing any D1 row.
 *    Allowed regardless of the flag (no side effects). (OPE-190)
 *  - `test_recipient` set → sends ONLY to that address (for verification). The
 *    issue record is upserted with sent_at=null (excluded from the public
 *    archive). Allowed regardless of the flag.
 *  - broadcast (no test_recipient) → sends to the whole eligible list. Gated
 *    behind NEWSLETTER_SEND_ENABLED === "true" (OPE-6 customer-facing send).
 *    Sets the issue's sent_at.
 *
 * Auth (OPE-190): withAuthorized — an admin session OR X-Internal-Key, so the
 * MCP-server `send_newsletter_broadcast` tool can forward here without a
 * Next.js session cookie (mirrors the /api/admin/duplicates/merge pattern).
 *
 * Body: { subject, content_html, audience, content_text?, test_recipient?,
 * preview_only? }. `audience` ('weekend' | 'vendor') is REQUIRED with no default
 * (OPE-795) — this route previously hardcoded 'weekend', so the vendor list had
 * no manual send path and any caller assuming one would have mailed the vendor
 * newsletter to 39 attendees and 0 vendors.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { NEWSLETTER_LISTS, newsletterIssues } from "@/lib/db/schema";
import { resolveUnsubscribeSecret } from "@/lib/email/newsletter-unsubscribe-token";
import { resolveApproveSecret, signApproveToken } from "@/lib/email/newsletter-approve-token";
import {
  enqueueNewsletterDigest,
  parseNewsletterList,
  selectBroadcastRecipients,
} from "@/lib/email/newsletter-broadcast";
import { newsletterNameForAudience } from "@/lib/newsletter-masthead";
import { getSiteUrl } from "@/lib/email/send";
import { createSlug } from "@takemetothefair/utils";

// Cap the recipient list echoed back in a preview so a full-list pre-flight
// doesn't return a multi-thousand-entry payload. The count is always exact.
const PREVIEW_RECIPIENT_CAP = 200;

type Body = {
  subject?: unknown;
  content_html?: unknown;
  content_text?: unknown;
  test_recipient?: unknown;
  preview_only?: unknown;
  audience?: unknown;
};

export const POST = withAuthorized(async ({ request, db }) => {
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
  const previewOnly = body.preview_only === true;
  if (!subject || !contentHtml) {
    return NextResponse.json(
      { error: "missing_fields", message: "`subject` and `content_html` are required." },
      { status: 400 }
    );
  }

  // OPE-795 — `audience` is REQUIRED, with no default, on every mode.
  //
  // This route used to pass the literal "weekend" to selectBroadcastRecipients,
  // so the only reachable audience was the attendee list (39 addresses) and the
  // vendor list (3) had no manual send path at all. A default here would keep
  // the defect dangerous rather than fix it: an omitted argument would silently
  // resolve to the LARGER list, and a broadcast to too many people is
  // indistinguishable from a successful one. Erroring is the whole point.
  const audience = parseNewsletterList(body.audience);
  if (!audience) {
    return NextResponse.json(
      {
        error: "invalid_audience",
        message:
          "`audience` is required and must be one of: " +
          `${NEWSLETTER_LISTS.join(", ")}. There is deliberately no default — ` +
          "an omitted audience would resolve to the larger list and mail the wrong people.",
      },
      { status: 400 }
    );
  }

  const isBroadcast = !testRecipient;
  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;

  // OPE-6 gate — a real broadcast to the list needs the flag. A single-address
  // test send and a read-only preview are always allowed (a preview sends
  // nothing, so gating it would defeat its purpose as a pre-flight).
  if (isBroadcast && !previewOnly && env.NEWSLETTER_SEND_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "broadcast_disabled",
        message:
          "Broadcast sending is disabled (NEWSLETTER_SEND_ENABLED != 'true'). Use test_recipient to verify formatting, or enable the flag to broadcast to the list.",
      },
      { status: 409 }
    );
  }

  const siteUrl = getSiteUrl();
  const now = new Date();
  const slug = `${createSlug(subject)}-${now.toISOString().slice(0, 10)}`.slice(0, 120);
  const viewInBrowserUrl = `${siteUrl}/newsletter/${slug}`;

  // Resolve recipients (identical selection for preview and a real send). The
  // broadcast selection is shared with the OPE-231 approve route so both honour
  // the same suppression list.
  const recipients = testRecipient
    ? [testRecipient]
    : await selectBroadcastRecipients(db, audience);

  // OPE-190 — read-only preview. Return the resolved recipients + the issue
  // shape that WOULD be written, with zero side effects (no upsert, no enqueue,
  // no D1 write). Lets the analyst pre-flight without a live inbox.
  if (previewOnly) {
    return NextResponse.json({
      success: true,
      preview: true,
      mode: isBroadcast ? "broadcast" : "test",
      issue: {
        slug,
        subject,
        audience,
        html_length: contentHtml.length,
        would_set_sent_at: isBroadcast,
      },
      // OPE-795 — echoed at the top level too, so a pre-flight reader cannot
      // mistake WHICH list the count below belongs to. The count alone is what
      // made the original defect legible only by recognising 39 addresses.
      audience,
      view_in_browser: viewInBrowserUrl,
      recipient_count: recipients.length,
      recipients: recipients.slice(0, PREVIEW_RECIPIENT_CAP),
      recipients_truncated: recipients.length > PREVIEW_RECIPIENT_CAP,
    });
  }

  // ── Real send path ──────────────────────────────────────────────────────
  const secret = resolveUnsubscribeSecret(env);
  if (!secret) {
    return NextResponse.json(
      { error: "no_secret", message: "No unsubscribe signing secret configured." },
      { status: 500 }
    );
  }

  // Upsert the issue record. sent_at is set only on a real broadcast — a test
  // leaves it null so it's excluded from the public archive but /newsletter/{slug}
  // still resolves for the view-in-browser link.
  await db
    .insert(newsletterIssues)
    // OPE-359 — explicit even though 'weekend' is the column default. Relying on
    // a default means the value is invisible at the call site, and this is the
    // writer whose audience must never drift.
    .values({
      slug,
      subject,
      html: contentHtml,
      audience,
      sentAt: isBroadcast ? now : null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: newsletterIssues.slug,
      // OPE-795 — `audience` is set on the UPDATE branch too, matching the
      // vendor-digest route's OPE-359 reasoning: an issue re-composed under a
      // different audience must not keep the first one, or the approve route
      // (which reads this column to pick its recipients) targets the wrong list.
      set: { subject, html: contentHtml, audience, ...(isBroadcast ? { sentAt: now } : {}) },
    });
  const mailingAddress = env.MAILING_ADDRESS;

  // OPE-231 — mint the one-tap approve link, but ONLY for a preview (test) send:
  // this is the email John reviews. A broadcast never carries it. Best-effort —
  // if no approve secret is configured, the preview still sends, just without
  // the button (John falls back to the manual approval path).
  //
  // OPE-284 — and only while the broadcast gate is ON. The gate used to be read
  // exclusively at click time, so a preview composed with sending disabled still
  // rendered an active "Approve & send to everyone" button that the API would
  // then refuse — John hit precisely that on 2026-07-23. Reading the flag HERE
  // makes the email honest at compose time; `approveDisabled` renders the reason
  // in the button's place. A CTA built on a feature gate must check that gate at
  // render time, not only at execution time.
  let approveUrl: string | undefined;
  let approveDisabled = false;
  if (!isBroadcast) {
    if (env.NEWSLETTER_SEND_ENABLED !== "true") {
      approveDisabled = true;
    } else {
      const approveSecret = resolveApproveSecret(env);
      if (approveSecret) {
        const approveToken = await signApproveToken(slug, approveSecret, now);
        approveUrl = `${siteUrl}/newsletter/approve?token=${approveToken}`;
      }
    }
  }

  const queued = await enqueueNewsletterDigest({
    recipients,
    subject,
    contentHtml,
    contentText,
    viewInBrowserUrl,
    siteUrl,
    secret,
    mailingAddress,
    approveUrl,
    approveDisabled,
    // OPE-795 / OPE-711 §2 — the masthead + "you subscribed to ..." footer follow
    // the audience on the manual path too. Without this a vendor issue sent from
    // here would tell vendors they had signed up for the attendee newsletter,
    // which is exactly the defect OPE-711 fixed on the generator path.
    wordmark: newsletterNameForAudience(audience),
  });

  return NextResponse.json({
    success: true,
    mode: isBroadcast ? "broadcast" : "test",
    issue_slug: slug,
    view_in_browser: viewInBrowserUrl,
    recipients: queued,
  });
});

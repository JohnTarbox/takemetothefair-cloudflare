export const dynamic = "force-dynamic";
/**
 * OPE-191 §4 — compose and send the "New This Week" vendor digest.
 *
 * Called by the MCP Worker's Monday cron. It exists as an endpoint rather than
 * living in the Worker because everything it needs — the selection query, the
 * vendor template, the recipient rules, issue persistence — is main-app code,
 * and a second copy in the Worker is how two senders drift until one stops
 * honouring the suppression list.
 *
 * ── Three ways this refuses to send, in order ───────────────────────────────
 *   1. No qualifying shows        → nothing sent (the §2 "0 rows → skip" rule;
 *                                    an empty digest is worse than no digest).
 *   2. VENDOR_DIGEST_SEND_ENABLED → not "true" means compose + persist only.
 *      This is the OPE-6 STOP-gate made structural: the Monday job can run for
 *      weeks, producing a real reviewable issue at /newsletter/{slug}, without
 *      ever mailing the vendor list. John flips the flag when he's satisfied.
 *   3. test_recipient             → a single address, never the list.
 *
 * A broadcast is only reached when none of those apply, which is deliberately
 * the hardest path to arrive at by accident.
 */
import { NextResponse } from "next/server";
import { withAuthorized } from "@/lib/api/with-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { resolveUnsubscribeSecret } from "@/lib/email/newsletter-unsubscribe-token";
import {
  selectBroadcastRecipients,
  enqueueNewsletterDigest,
  VENDOR_DIGEST_SOURCE,
} from "@/lib/email/newsletter-broadcast";
import { selectNewThisWeekEvents } from "@/lib/newsletter/new-this-week";
import { renderVendorDigestContent } from "@/lib/email/vendor-digest";
import { getSiteUrl } from "@/lib/email/send";
import { createSlug } from "@takemetothefair/utils";

/** Subject stem; the ISO date is appended so each week gets its own slug. */
const SUBJECT_STEM = "New This Week — shows just added";

export const POST = withAuthorized(async ({ request, db }) => {
  const body = (await request.json().catch(() => ({}))) as {
    test_recipient?: unknown;
    /** Compose + report what WOULD happen, writing and sending nothing. */
    dry_run?: unknown;
  };
  const testRecipient =
    typeof body.test_recipient === "string" ? body.test_recipient.trim().toLowerCase() : "";
  const dryRun = body.dry_run === true;

  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  const siteUrl = getSiteUrl();
  const now = new Date();

  const events = await selectNewThisWeekEvents(db, now);
  const contentHtml = renderVendorDigestContent(events, now);

  // Refusal 1 — never mail an empty issue. Reported as ok:true because a quiet
  // week is a normal outcome, not a failure the cron should retry or alarm on.
  if (!contentHtml) {
    return NextResponse.json({
      success: true,
      sent: false,
      reason: "no_new_events",
      event_count: 0,
    });
  }

  const subject = `${SUBJECT_STEM} (${events.length})`;
  const slug = `${createSlug(SUBJECT_STEM)}-${now.toISOString().slice(0, 10)}`.slice(0, 120);
  const viewInBrowserUrl = `${siteUrl}/newsletter/${slug}`;

  const broadcastEnabled = env.VENDOR_DIGEST_SEND_ENABLED === "true";
  const isBroadcast = !testRecipient && broadcastEnabled;

  const recipients = testRecipient
    ? [testRecipient]
    : broadcastEnabled
      ? await selectBroadcastRecipients(db, "vendor")
      : [];

  if (dryRun) {
    return NextResponse.json({
      success: true,
      dry_run: true,
      event_count: events.length,
      slug,
      subject,
      would_broadcast: isBroadcast,
      broadcast_enabled: broadcastEnabled,
      recipient_count: recipients.length,
      view_in_browser: viewInBrowserUrl,
    });
  }

  // Persist the issue even when not sending. That is the point of refusal 2:
  // /newsletter/{slug} renders a real, reviewable issue each Monday while the
  // flag is off. sent_at stays null so it is excluded from the public archive
  // and honest about never having been broadcast (OPE-285's invariant).
  await db
    .insert(newsletterIssues)
    .values({
      slug,
      subject,
      html: contentHtml,
      sentAt: isBroadcast ? now : null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: newsletterIssues.slug,
      set: { subject, html: contentHtml, ...(isBroadcast ? { sentAt: now } : {}) },
    });

  if (recipients.length === 0) {
    return NextResponse.json({
      success: true,
      sent: false,
      reason: broadcastEnabled ? "no_recipients" : "broadcast_disabled",
      event_count: events.length,
      slug,
      view_in_browser: viewInBrowserUrl,
    });
  }

  const secret = resolveUnsubscribeSecret(env);
  if (!secret) {
    return NextResponse.json(
      { error: "no_secret", message: "No unsubscribe signing secret configured." },
      { status: 500 }
    );
  }

  const queued = await enqueueNewsletterDigest({
    recipients,
    subject,
    contentHtml,
    viewInBrowserUrl,
    siteUrl,
    secret,
    mailingAddress: env.MAILING_ADDRESS,
    source: VENDOR_DIGEST_SOURCE,
  });

  return NextResponse.json({
    success: true,
    sent: true,
    broadcast: isBroadcast,
    event_count: events.length,
    slug,
    queued,
    view_in_browser: viewInBrowserUrl,
  });
});

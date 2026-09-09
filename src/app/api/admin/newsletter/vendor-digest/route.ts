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
 * ── Four ways this refuses to send, in order ────────────────────────────────
 *   1. No qualifying shows        → nothing sent (the §2 "0 rows → skip" rule;
 *                                    an empty digest is worse than no digest).
 *   2. VENDOR_DIGEST_SEND_ENABLED → not "true" means compose + persist only.
 *      This is the OPE-6 STOP-gate made structural: the Monday job can run for
 *      weeks, producing a real reviewable issue at /newsletter/{slug}, without
 *      ever mailing the vendor list. John flips the flag when he's satisfied.
 *   3. test_recipient             → a single address, never the list.
 *   4. require_human_confirmation → OPE-862. Even with the flag on, a real
 *      broadcast needs the operator token. See below.
 *
 * A broadcast is only reached when none of those apply, which is deliberately
 * the hardest path to arrive at by accident.
 *
 * ── Refusal 4, and why the flag was not enough (OPE-862) ────────────────────
 *
 * Refusal 2 was written as "John flips the flag when he's satisfied" — a
 * ONE-TIME approval of the mechanism. It was then read, reasonably, as a
 * standing approval of every individual send. Those are different things, and
 * on 2026-09-09 the difference cost a real broadcast: `VENDOR_DIGEST_SEND_ENABLED`
 * had been "true" in committed config for weeks, so a NO-ARGUMENT
 * `send_vendor_digest` call went to all three vendor pilots. Nothing
 * malfunctioned. Every gate did exactly what it said.
 *
 * The sibling tool already had the missing piece: `send_newsletter_broadcast`
 * refuses a real broadcast without `require_human_confirmation` (OPE-795). It
 * reaches the same list. So the gate is not new, it is merely applied to the
 * second door into the same room.
 *
 * ⚠️ A missing token DEGRADES to refusal 2 rather than erroring. The issue is
 * still composed and still persisted at /newsletter/{slug} for review; only the
 * mail is withheld. That is deliberate: if the Monday cron is ever restored
 * (OPE-711 §1 removed its schedule, so there is no unattended caller today), an
 * un-tokened run must keep producing the weekly reviewable issue exactly as it
 * does with the flag off. A hard 4xx there would silently stop the artifact
 * John reviews, and we would have traded a send nobody authorised for a
 * newsletter nobody can see.
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
import { BROADCAST_CONFIRM_TOKEN } from "@takemetothefair/constants";
import { newsletterNameForAudience } from "@/lib/newsletter-masthead";

/** Subject stem; the ISO date is appended so each week gets its own slug. */
const SUBJECT_STEM = "New This Week — shows just added";

export const POST = withAuthorized(async ({ request, db }) => {
  const body = (await request.json().catch(() => ({}))) as {
    test_recipient?: unknown;
    /** Compose + report what WOULD happen, writing and sending nothing. */
    dry_run?: unknown;
    /** OPE-862 — the operator token; refusal 4. */
    require_human_confirmation?: unknown;
  };
  const testRecipient =
    typeof body.test_recipient === "string" ? body.test_recipient.trim().toLowerCase() : "";
  const dryRun = body.dry_run === true;
  // Strict equality against the shared token, for the same reason every gate
  // above compares to exactly "true": a truthiness test would accept any
  // non-empty string, and "no" is a non-empty string.
  const humanConfirmed = body.require_human_confirmation === BROADCAST_CONFIRM_TOKEN;

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
  // OPE-862 — the flag says the mechanism is approved; the token says THIS send
  // is. Both are required to reach the list, and neither implies the other.
  const broadcastAuthorized = broadcastEnabled && humanConfirmed;
  const isBroadcast = !testRecipient && broadcastAuthorized;

  const recipients = testRecipient
    ? [testRecipient]
    : broadcastAuthorized
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
      // OPE-862 — report the token separately from the flag. Collapsing them
      // into one "would_broadcast" boolean is what made the 09-09 state
      // unreadable: the caller could not tell WHICH of the two was missing.
      human_confirmed: humanConfirmed,
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
      // OPE-359 — the discriminator that keeps this out of the public consumer
      // archive. Set on BOTH branches of the upsert: an issue composed while the
      // send flag was off, then re-composed later, must not silently revert to
      // the 'weekend' default and surface publicly.
      audience: "vendor",
      sentAt: isBroadcast ? now : null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: newsletterIssues.slug,
      set: {
        subject,
        html: contentHtml,
        audience: "vendor",
        ...(isBroadcast ? { sentAt: now } : {}),
      },
    });

  if (recipients.length === 0) {
    // OPE-862 — three distinct reasons, never collapsed. "The flag is off",
    // "nobody approved this send" and "the list is empty" are different states
    // that need different operator responses, and reporting them under one
    // string is what left the 09-09 responder unable to tell them apart.
    const reason = !broadcastEnabled
      ? "broadcast_disabled"
      : !humanConfirmed
        ? "missing_human_confirmation"
        : "no_recipients";
    return NextResponse.json({
      success: true,
      sent: false,
      reason,
      ...(reason === "missing_human_confirmation"
        ? {
            refused: true,
            message:
              `A real broadcast to the vendor list requires require_human_confirmation: ` +
              `"${BROADCAST_CONFIRM_TOKEN}". Pass it only after John has explicitly approved ` +
              `this send. The issue was composed and persisted for review; no mail was queued.`,
          }
        : {}),
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
    // OPE-711 — audience-aware masthead + footer. Without this the issue tells
    // a vendor subscriber they signed up for "This Weekend at the Fair", which
    // is the OTHER list.
    wordmark: newsletterNameForAudience("vendor"),
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

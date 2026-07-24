// OPE-231 — the newsletter broadcast primitives, factored out of
// /api/admin/newsletter/send so there is exactly ONE implementation of
// "who receives a broadcast" and "how a digest is rendered + enqueued".
//
// Before this, the send route held that logic inline. The one-tap approve route
// (OPE-231) needs the identical selection + render, and a second hand-rolled
// copy is precisely how two send paths drift until one of them stops honouring
// the suppression list. Both callers now share these functions.

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { newsletterSubscribers, emailSuppressionList } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/queues/producers";
import { newsletterDigestTemplate } from "@/lib/email/templates";
import { signUnsubscribeToken } from "@/lib/email/newsletter-unsubscribe-token";

type Db = DrizzleD1Database<Record<string, unknown>>;

export const NEWSLETTER_SOURCE = "newsletter:weekly-digest";
export const NEWSLETTER_FROM = "Meet Me at the Fair <hello@meetmeatthefair.com>";

/**
 * The eligible broadcast list: confirmed, not unsubscribed, minus every address
 * on the suppression list. This is the ONLY definition of "the list" — the
 * approve route and the send route both call it, so a hard bounce suppressed in
 * one place is honoured everywhere.
 */
export async function selectBroadcastRecipients(db: Db): Promise<string[]> {
  const subs = await db
    .select({ email: newsletterSubscribers.email })
    .from(newsletterSubscribers)
    .where(
      and(eq(newsletterSubscribers.confirmed, true), eq(newsletterSubscribers.unsubscribed, false))
    );
  const suppressedRows = await db
    .select({ email: emailSuppressionList.email })
    .from(emailSuppressionList);
  const suppressed = new Set(suppressedRows.map((r) => r.email.toLowerCase()));
  return subs.map((s) => s.email).filter((e) => !suppressed.has(e.toLowerCase()));
}

/**
 * Render the digest per recipient (each with its own signed unsubscribe URL)
 * and enqueue it. Returns the number enqueued. The queue consumer performs the
 * actual send + ledgers it (source `newsletter:weekly-digest`).
 *
 * `contentHtml` is the stored issue body — the same value the approve route
 * reads back from `newsletter_issues.html`, so a broadcast re-sends exactly what
 * was previewed, no re-render of the content.
 */
export async function enqueueNewsletterDigest(args: {
  recipients: string[];
  subject: string;
  contentHtml: string;
  contentText?: string;
  viewInBrowserUrl: string;
  siteUrl: string;
  secret: string;
  mailingAddress?: string;
  /**
   * OPE-231 — the one-tap approve button, threaded straight to the template.
   * The SAFETY rule (a broadcast must never carry it) is enforced by the
   * callers: the approve route never sets it, and the send route sets it only
   * on a test/preview send. A broadcast call simply omits it.
   */
  approveUrl?: string;
  /**
   * OPE-284 — the preview was composed while `NEWSLETTER_SEND_ENABLED` was off,
   * so the template renders why the approve button is absent instead of showing
   * one the API would refuse. Same caller contract as `approveUrl`: previews
   * only, never a broadcast.
   */
  approveDisabled?: boolean;
}): Promise<number> {
  let queued = 0;
  for (const email of args.recipients) {
    const token = await signUnsubscribeToken(email, args.secret);
    const unsubscribeUrl = `${args.siteUrl}/api/newsletter/unsubscribe?token=${token}`;
    const tpl = newsletterDigestTemplate({
      subject: args.subject,
      contentHtml: args.contentHtml,
      contentText: args.contentText,
      unsubscribeUrl,
      viewInBrowserUrl: args.viewInBrowserUrl,
      mailingAddress: args.mailingAddress,
      approveUrl: args.approveUrl,
      approveDisabled: args.approveDisabled,
    });
    await enqueueEmail({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      from: NEWSLETTER_FROM,
      source: NEWSLETTER_SOURCE,
    });
    queued++;
  }
  return queued;
}

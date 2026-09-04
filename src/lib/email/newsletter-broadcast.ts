// OPE-231 — the newsletter broadcast primitives, factored out of
// /api/admin/newsletter/send so there is exactly ONE implementation of
// "who receives a broadcast" and "how a digest is rendered + enqueued".
//
// Before this, the send route held that logic inline. The one-tap approve route
// (OPE-231) needs the identical selection + render, and a second hand-rolled
// copy is precisely how two send paths drift until one of them stops honouring
// the suppression list. Both callers now share these functions.

import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  newsletterSubscribers,
  newsletterListSubscriptions,
  emailSuppressionList,
  NEWSLETTER_LISTS,
  type NewsletterList,
} from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/queues/producers";
import { newsletterDigestTemplate } from "@/lib/email/templates";
import { signUnsubscribeToken } from "@/lib/email/newsletter-unsubscribe-token";

type Db = DrizzleD1Database<Record<string, unknown>>;

export const NEWSLETTER_SOURCE = "newsletter:weekly-digest";
/** OPE-191 — the vendor digest's own ledger source. Distinct from the attendee
 *  digest's so "did the vendor digest go out this week?" is answerable from
 *  email_send_ledger. Sharing one source made the two indistinguishable, which
 *  a post-send check caught: the first vendor test landed under
 *  `newsletter:weekly-digest` and was invisible as a vendor send. */
export const VENDOR_DIGEST_SOURCE = "newsletter:vendor-digest";
export const NEWSLETTER_FROM = "Meet Me at the Fair <hello@meetmeatthefair.com>";

/**
 * The eligible broadcast list for ONE audience: confirmed, not globally
 * unsubscribed, actively subscribed to `list`, minus every suppressed address.
 * This is the ONLY definition of "the list" — the approve route and the send
 * route both call it, so a hard bounce suppressed in one place is honoured
 * everywhere.
 *
 * `list` is REQUIRED on purpose (OPE-191). Making it optional, with "all
 * confirmed subscribers" as the fallback, would mean a caller that forgets it
 * mails the wrong audience — and the failure is invisible, because a send to
 * too many people looks exactly like a successful send. The 0182 backfill
 * enrolled every existing confirmed subscriber in `weekend`, so the attendee
 * digest keeps precisely the audience it had.
 *
 * The global `unsubscribed` flag is checked as well as the per-list one: an
 * unsubscribe must mean "stop all mail", and a stale list row must never be
 * able to resurrect someone.
 */
/**
 * Narrow an untrusted string (a request body field, a `newsletter_issues.audience`
 * column read) to a real audience list, or `null`.
 *
 * OPE-795 — returns `null` rather than falling back to a default ON PURPOSE, and
 * the direction matters. `newsletterNameForAudience()` falls back to the consumer
 * NAME for an unknown audience, which is the safe direction for a wordmark: the
 * worst case is a mislabelled masthead. Falling back for RECIPIENT SELECTION is
 * the opposite — 'weekend' is the larger list (39 vs 3), so a default sends the
 * wrong newsletter to more people than intended, and a send to too many looks
 * exactly like a successful send. Callers must refuse, not guess.
 */
export function parseNewsletterList(value: unknown): NewsletterList | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (NEWSLETTER_LISTS as readonly string[]).includes(v) ? (v as NewsletterList) : null;
}

export async function selectBroadcastRecipients(db: Db, list: NewsletterList): Promise<string[]> {
  const subs = await db
    .select({ email: newsletterSubscribers.email })
    .from(newsletterSubscribers)
    .innerJoin(
      newsletterListSubscriptions,
      eq(newsletterListSubscriptions.subscriberId, newsletterSubscribers.id)
    )
    .where(
      and(
        eq(newsletterSubscribers.confirmed, true),
        eq(newsletterSubscribers.unsubscribed, false),
        eq(newsletterListSubscriptions.list, list),
        isNull(newsletterListSubscriptions.unsubscribedAt)
      )
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
   * OPE-191 — ledger source. Defaults to the attendee digest's. The vendor
   * digest passes VENDOR_DIGEST_SOURCE so the two are separable in
   * email_send_ledger; without it, neither digest's cadence is checkable.
   */
  source?: string;
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
  /**
   * OPE-711 — the newsletter NAME shown in the masthead and in the footer's
   * "you subscribed to ..." sentence. Defaults to the consumer name.
   *
   * Threaded on the SHARED rail rather than set inside either composer, for the
   * same reason `listUnsubscribe` is: both audiences enqueue through here, so
   * both inherit one behaviour. Two copies is how OPE-359's audience bug
   * happened.
   */
  wordmark?: string;
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
      wordmark: args.wordmark,
    });
    await enqueueEmail({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      from: NEWSLETTER_FROM,
      source: args.source ?? NEWSLETTER_SOURCE,
      // OPE-385 — RFC 8058 one-click unsubscribe.
      //
      // Deliberately set HERE, on the shared rail, not in either composer.
      // Both audiences (weekend + vendor) enqueue through this function, so
      // both inherit it by construction. Putting it in the composers would be
      // two copies that drift — exactly how OPE-359's audience bug happened.
      //
      // Reuses `unsubscribeUrl` — the SAME per-recipient signed token the
      // footer link uses. One mechanism, one target: a recipient can never be
      // offered a header and a footer that disagree about what they unsubscribe
      // from, and there is no second token type to expire or leak.
      listUnsubscribe: `<${unsubscribeUrl}>`,
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
    queued++;
  }
  return queued;
}

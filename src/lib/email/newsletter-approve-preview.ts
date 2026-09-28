/**
 * OPE-1204 — what the OPE-231 approve interstitial is about to send, and to whom.
 *
 * The confirm page used to count `selectBroadcastRecipients(db, "weekend")`
 * whatever the issue was. OPE-795 fixed the POST that actually sends (it reads
 * `newsletter_issues.audience`) but left this reader behind, so on 2026-09-28 a
 * VENDOR issue showed "Approve & send to 75 subscribers" — the weekend count —
 * while the button would have mailed the 4 vendor subscribers. The send was
 * right and the approval screen was wrong, which is the worse half to get wrong:
 * the number on the button is the thing John approves.
 *
 * Both the page and any future reader resolve through this one function, using
 * the same `parseNewsletterList` + `selectBroadcastRecipients` pair the POST
 * uses, so the count shown and the count sent cannot drift apart again.
 */
import { eq } from "drizzle-orm";
import { newsletterIssues, type NewsletterList } from "@/lib/db/schema";
import { parseNewsletterList, selectBroadcastRecipients } from "@/lib/email/newsletter-broadcast";
import { newsletterNameForAudience } from "@/lib/newsletter-masthead";

type Db = Parameters<typeof selectBroadcastRecipients>[0];

export type ApprovePreview =
  | {
      kind: "ready";
      subject: string;
      audience: NewsletterList;
      /** The product name of that list, e.g. "New This Week". */
      audienceName: string;
      recipientCount: number;
    }
  | { kind: "not_found" }
  | { kind: "already_sent" }
  /** The issue's stored audience is NULL or not a known list. Refuse — never
   *  default: 'weekend' is the larger list, so a guess mails the wrong people. */
  | { kind: "unknown_audience" };

export async function resolveApprovePreview(db: Db, slug: string): Promise<ApprovePreview> {
  const [issue] = await db
    .select({
      subject: newsletterIssues.subject,
      sentAt: newsletterIssues.sentAt,
      audience: newsletterIssues.audience,
    })
    .from(newsletterIssues)
    .where(eq(newsletterIssues.slug, slug))
    .limit(1);

  if (!issue) return { kind: "not_found" };
  if (issue.sentAt) return { kind: "already_sent" };

  const audience = parseNewsletterList(issue.audience);
  if (!audience) return { kind: "unknown_audience" };

  const recipientCount = (await selectBroadcastRecipients(db, audience)).length;
  return {
    kind: "ready",
    subject: issue.subject,
    audience,
    audienceName: newsletterNameForAudience(audience),
    recipientCount,
  };
}

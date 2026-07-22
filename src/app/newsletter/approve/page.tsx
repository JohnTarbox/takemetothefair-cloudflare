export const dynamic = "force-dynamic";
import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2, AlertCircle, Send } from "lucide-react";
import { eq } from "drizzle-orm";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { resolveApproveSecret, verifyApproveToken } from "@/lib/email/newsletter-approve-token";
import { selectBroadcastRecipients } from "@/lib/email/newsletter-broadcast";

/**
 * OPE-231 — the confirm interstitial for the one-tap approve link.
 *
 * This page is READ-ONLY: it renders either a confirmation form (which POSTs to
 * /api/newsletter/approve) or a result message. It never sends — that separation
 * is what makes the email link safe to prefetch, since a mail-client scanner
 * does a GET and a GET here has no side effect.
 */
export const metadata: Metadata = {
  title: "Approve Newsletter | Meet Me at the Fair",
  description: "Approve and send the Weekend Fair Digest to subscribers.",
  robots: { index: false, follow: false },
};

interface Props {
  searchParams: Promise<{ token?: string; status?: string; count?: string }>;
}

interface ResultCopy {
  icon: typeof CheckCircle2;
  iconClass: string;
  heading: string;
  body: string;
}

/** Copy for the post-POST result redirect (?status=…) and pre-send errors. */
function resultCopy(status: string, count?: string): ResultCopy {
  switch (status) {
    case "sent":
      return {
        icon: CheckCircle2,
        iconClass: "text-green-600",
        heading: "Sent to the list",
        body: `The digest is on its way${count ? ` to ${count} subscriber${count === "1" ? "" : "s"}` : ""}. It's now published on the newsletter archive too.`,
      };
    case "already_sent":
      return {
        icon: AlertCircle,
        iconClass: "text-amber-600",
        heading: "This issue was already sent",
        body: "Nothing was sent again — this digest had already gone out to the list. Approval links are single-use on purpose.",
      };
    case "disabled":
      return {
        icon: AlertCircle,
        iconClass: "text-amber-600",
        heading: "Sending is turned off",
        body: "Broadcast sending is disabled (NEWSLETTER_SEND_ENABLED is not 'true'), so nothing was sent. Enable it first, then use the approve link again.",
      };
    case "not_found":
      return {
        icon: AlertCircle,
        iconClass: "text-red-600",
        heading: "Issue not found",
        body: "We couldn't find the previewed issue this link points at. It may have been removed. Nothing was sent.",
      };
    case "invalid":
      return {
        icon: AlertCircle,
        iconClass: "text-red-600",
        heading: "This approval link isn't valid",
        body: "The link is incomplete, expired, or couldn't be verified. Open it straight from the preview email; approval links expire after 72 hours. Nothing was sent.",
      };
    default:
      return {
        icon: AlertCircle,
        iconClass: "text-red-600",
        heading: "Something went wrong",
        body: "We hit an unexpected error and did not send anything. Please try the link again in a minute.",
      };
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-16">
      <div className="rounded-xl border border-border bg-card p-8 text-center">{children}</div>
    </div>
  );
}

function ResultView({ copy }: { copy: ResultCopy }) {
  const Icon = copy.icon;
  return (
    <Shell>
      <div className="flex justify-center mb-4">
        <Icon className={`w-12 h-12 ${copy.iconClass}`} aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-bold text-foreground mb-3">{copy.heading}</h1>
      <p className="text-muted-foreground mb-8">{copy.body}</p>
      <Link
        href="/"
        className="inline-flex items-center px-5 py-2.5 bg-secondary text-secondary-foreground font-medium rounded-lg hover:bg-secondary/90 transition-colors"
      >
        Back to Meet Me at the Fair
      </Link>
    </Shell>
  );
}

export default async function NewsletterApprovePage({ searchParams }: Props) {
  const { token, status, count } = await searchParams;

  // Post-POST redirect: show the outcome, no token work.
  if (status) return <ResultView copy={resultCopy(status, count)} />;

  if (!token) return <ResultView copy={resultCopy("invalid")} />;

  const env = getCloudflareEnv() as unknown as Record<string, string | undefined>;
  const secret = resolveApproveSecret(env);
  if (!secret) return <ResultView copy={resultCopy("server_error")} />;

  const claims = await verifyApproveToken(token, secret);
  if (!claims) return <ResultView copy={resultCopy("invalid")} />;

  const db = getCloudflareDb();
  const [issue] = await db
    .select({
      subject: newsletterIssues.subject,
      sentAt: newsletterIssues.sentAt,
    })
    .from(newsletterIssues)
    .where(eq(newsletterIssues.slug, claims.slug))
    .limit(1);

  if (!issue) return <ResultView copy={resultCopy("not_found")} />;
  if (issue.sentAt) return <ResultView copy={resultCopy("already_sent")} />;
  if (env.NEWSLETTER_SEND_ENABLED !== "true") return <ResultView copy={resultCopy("disabled")} />;

  const recipientCount = (await selectBroadcastRecipients(db)).length;

  // Valid + pending + enabled → the confirm form. The POST (not this GET) sends.
  return (
    <Shell>
      <div className="flex justify-center mb-4">
        <Send className="w-12 h-12 text-primary" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-bold text-foreground mb-3">Send this digest to everyone?</h1>
      <p className="text-muted-foreground mb-2">
        <span className="font-semibold text-foreground">{issue.subject}</span>
      </p>
      <p className="text-muted-foreground mb-8">
        This will send the previewed issue to{" "}
        <span className="font-semibold text-foreground">
          {recipientCount} subscriber{recipientCount === 1 ? "" : "s"}
        </span>
        . This can&apos;t be undone.
      </p>
      <form method="POST" action="/api/newsletter/approve">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Send className="w-4 h-4" aria-hidden="true" />
          Approve &amp; send to {recipientCount} subscriber{recipientCount === 1 ? "" : "s"}
        </button>
      </form>
      <p className="mt-6">
        <Link href="/" className="text-sm text-muted-foreground underline hover:text-foreground">
          Cancel
        </Link>
      </p>
    </Shell>
  );
}

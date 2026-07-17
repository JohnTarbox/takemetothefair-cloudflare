export const dynamic = "force-dynamic";
import Link from "next/link";
import type { Metadata } from "next";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { desc, isNotNull } from "drizzle-orm";
import { NewsletterSignup } from "@/components/layout/newsletter-signup";
import { newsletterMastheadHtml } from "@/lib/newsletter-masthead";

/**
 * OPE-170 — public newsletter archive. Reverse-chron list of SENT issues
 * (sent_at not null; test-only records excluded). Each links to its own
 * /newsletter/{slug} page. Carries a subscribe CTA (growth loop). Indexable
 * once it has content; noindex while empty to avoid thin-content.
 */

async function getSentIssues() {
  try {
    const db = getCloudflareDb();
    return await db
      .select({
        slug: newsletterIssues.slug,
        subject: newsletterIssues.subject,
        sentAt: newsletterIssues.sentAt,
      })
      .from(newsletterIssues)
      .where(isNotNull(newsletterIssues.sentAt))
      .orderBy(desc(newsletterIssues.sentAt))
      .limit(200);
  } catch {
    return [];
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const issues = await getSentIssues();
  return {
    title: "Newsletter Archive | Meet Me at the Fair",
    description:
      "Past issues of the Meet Me at the Fair weekend digest — New England fairs, festivals, new vendors, and hidden gems. Read online and subscribe.",
    alternates: { canonical: "https://meetmeatthefair.com/newsletter" },
    // Don't index an empty archive; index once there's at least one issue.
    robots: issues.length === 0 ? { index: false, follow: true } : undefined,
  };
}

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function NewsletterArchivePage() {
  const issues = await getSentIssues();

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12">
      {/* OPE-234 — same shared masthead as the per-issue page and the email, so
          the archive reads as the digest rather than a bare list. The band shows
          the wordmark visually; the <h1> is sr-only to avoid duplicating it
          on-screen while keeping a real heading for a11y + SEO. */}
      <h1 className="sr-only">Weekend Fair Digest — Newsletter Archive</h1>
      <div className="mb-6 overflow-hidden rounded-xl border border-border">
        <div dangerouslySetInnerHTML={{ __html: newsletterMastheadHtml({}) }} />
      </div>
      <p className="text-muted-foreground mb-8">
        Our weekly roundup of New England fairs, festivals, new vendors, and hidden gems. Read past
        issues below, or subscribe to get the next one in your inbox.
      </p>

      <div className="mb-10">
        <NewsletterSignup />
      </div>

      {issues.length === 0 ? (
        <p className="text-muted-foreground">
          No issues yet — subscribe above and you&apos;ll get the very first one.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {issues.map((issue) => (
            <li key={issue.slug}>
              <Link
                href={`/newsletter/${issue.slug}`}
                className="flex flex-col gap-1 px-5 py-4 hover:bg-muted transition-colors"
              >
                <span className="font-medium text-foreground">{issue.subject}</span>
                {issue.sentAt && (
                  <span className="text-sm text-muted-foreground">{fmtDate(issue.sentAt)}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

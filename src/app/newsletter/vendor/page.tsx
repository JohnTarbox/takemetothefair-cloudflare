export const dynamic = "force-dynamic";
import Link from "next/link";
import type { Metadata } from "next";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";

/**
 * OPE-359 — the vendor-facing newsletter archive ("New This Week").
 *
 * Separate from the public consumer archive at /newsletter, which now filters to
 * audience='weekend'. Without this split, the first live Monday vendor send
 * would appear in the consumer listing intermixed with "This Weekend at the
 * Fair" — different audience, different framing, same public page.
 *
 * ROUTE PRECEDENCE NOTE: this static `/newsletter/vendor` segment wins over the
 * sibling `[slug]` dynamic route, so an issue whose slug were literally "vendor"
 * would be unreachable. Composer slugs are date-suffixed
 * (`new-this-week-shows-just-added-YYYY-MM-DD`), so that cannot occur today —
 * recorded because it is invisible from either file alone.
 *
 * Per-issue pages are unaffected: /newsletter/{slug} still resolves for vendor
 * issues, which is what the email's view-in-browser link depends on.
 */

async function getSentVendorIssues() {
  try {
    const db = getCloudflareDb();
    return await db
      .select({
        slug: newsletterIssues.slug,
        subject: newsletterIssues.subject,
        sentAt: newsletterIssues.sentAt,
      })
      .from(newsletterIssues)
      .where(and(isNotNull(newsletterIssues.sentAt), eq(newsletterIssues.audience, "vendor")))
      .orderBy(desc(newsletterIssues.sentAt))
      .limit(200);
  } catch {
    return [];
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const issues = await getSentVendorIssues();
  return {
    title: "New This Week — Vendor Newsletter Archive | Meet Me at the Fair",
    description:
      "Past issues of New This Week, the Meet Me at the Fair newsletter for exhibitors — shows newly added to the site, with runway to apply for a booth.",
    alternates: { canonical: "https://meetmeatthefair.com/newsletter/vendor" },
    // Same thin-content rule the consumer archive uses: don't index an empty list.
    robots: issues.length === 0 ? { index: false, follow: true } : undefined,
  };
}

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function VendorNewsletterArchivePage() {
  const issues = await getSentVendorIssues();

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold text-foreground mb-2">New This Week</h1>
      <p className="text-muted-foreground mb-8">
        Our weekly newsletter for exhibitors: shows newly added to Meet Me at the Fair, with time
        left to apply for a booth. Past issues below.
      </p>

      {issues.length === 0 ? (
        <p className="text-muted-foreground">No issues have been sent yet.</p>
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

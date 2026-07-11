export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NewsletterSignup } from "@/components/layout/newsletter-signup";

/**
 * OPE-170 — public per-issue newsletter page. Renders the issue's stored HTML
 * (admin-authored via the send endpoint, OPE-169) inside the site chrome, with
 * a subscribe CTA. This is the target of the "view in browser" email link.
 */

interface Props {
  params: Promise<{ slug: string }>;
}

async function getIssue(slug: string) {
  try {
    const db = getCloudflareDb();
    const [row] = await db
      .select({
        slug: newsletterIssues.slug,
        subject: newsletterIssues.subject,
        html: newsletterIssues.html,
        sentAt: newsletterIssues.sentAt,
      })
      .from(newsletterIssues)
      .where(eq(newsletterIssues.slug, slug))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const issue = await getIssue(slug);
  if (!issue) return { title: "Newsletter | Meet Me at the Fair" };
  return {
    title: `${issue.subject} | Meet Me at the Fair`,
    description: "A past issue of the Meet Me at the Fair weekend digest.",
    alternates: { canonical: `https://meetmeatthefair.com/newsletter/${issue.slug}` },
    openGraph: { title: issue.subject, type: "article" },
  };
}

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export default async function NewsletterIssuePage({ params }: Props) {
  const { slug } = await params;
  const issue = await getIssue(slug);
  if (!issue) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12">
      <div className="mb-6">
        <Link href="/newsletter" className="text-sm text-royal hover:underline">
          ← All issues
        </Link>
      </div>
      <h1 className="text-3xl font-bold text-foreground mb-1">{issue.subject}</h1>
      {issue.sentAt && (
        <p className="text-sm text-muted-foreground mb-8">{fmtDate(issue.sentAt)}</p>
      )}

      {/* Stored issue HTML is admin-authored (send endpoint is admin-gated),
          so it's trusted content — same posture as rendered blog bodies. */}
      <article
        className="rounded-xl border border-border bg-card p-6 sm:p-8"
        dangerouslySetInnerHTML={{ __html: issue.html }}
      />

      <div className="mt-10 border-t border-border pt-8">
        <h2 className="text-lg font-semibold text-foreground mb-3">
          Get the next issue in your inbox
        </h2>
        <NewsletterSignup />
      </div>
    </div>
  );
}

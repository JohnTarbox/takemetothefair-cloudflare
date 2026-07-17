export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { newsletterIssues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { NewsletterSignup } from "@/components/layout/newsletter-signup";
import { newsletterMastheadHtml } from "@/lib/newsletter-masthead";

/**
 * OPE-170 — public per-issue newsletter page. Renders the issue's stored HTML
 * (admin-authored via the send endpoint, OPE-169) inside the site chrome, with
 * a subscribe CTA. This is the target of the "view in browser" email link.
 *
 * OPE-234 — the branded masthead comes from the SAME shared source as the email
 * (src/lib/newsletter-masthead.ts), so "view in browser" looks like the inbox.
 * The stored `html` is inner body only, so rendering the masthead here does NOT
 * double it in the email.
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
      {/* The masthead carries the subject visually (as its subtitle), so a
          visible <h1> would duplicate it. Keep a screen-reader-only one so the
          page still has a real document heading for a11y + SEO — the masthead
          wordmark is shared email markup and can't itself be an <h1>. */}
      <h1 className="sr-only">{issue.subject}</h1>

      {/* overflow-hidden clips the green band to the rounded top corners,
          mirroring the email shell's border-radius:12px + overflow:hidden. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* OPE-234 — same masthead source as the email; static, no user input. */}
        <div
          dangerouslySetInnerHTML={{ __html: newsletterMastheadHtml({ subtitle: issue.subject }) }}
        />
        {/* Stored issue HTML is admin-authored (send endpoint is admin-gated),
            so it's trusted content — same posture as rendered blog bodies. */}
        <article className="p-6 sm:p-8" dangerouslySetInnerHTML={{ __html: issue.html }} />
      </div>

      {issue.sentAt && (
        <p className="mt-3 text-sm text-muted-foreground">Sent {fmtDate(issue.sentAt)}</p>
      )}

      <div className="mt-10 border-t border-border pt-8">
        <h2 className="text-lg font-semibold text-foreground mb-3">
          Get the next issue in your inbox
        </h2>
        <NewsletterSignup />
      </div>
    </div>
  );
}

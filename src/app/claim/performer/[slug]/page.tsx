import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { performers } from "@/lib/db/schema";
import { unsafeSlug, decodeHtmlEntities } from "@/lib/utils";
import { ClaimEvidenceForm } from "@/components/claim/ClaimEvidenceForm";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Claim your performer page",
  // Claim funnels must never be indexed (OPE-43 posture for auth-adjacent flows).
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * OPE-318 — the performer claim page.
 *
 * Deliberately the EVIDENCE form rather than the vendor/promoter ClaimWizard.
 * The wizard's payoff is instant approval on an email/domain match, and that
 * path ends in a `userRoles` grant — but there is no PERFORMER role and no
 * /performer/* portal (a decision already made in performer-claim-approval.ts).
 * Wiring performers into it would mint a role that authorizes nothing and hand
 * someone a link to a dashboard that does not exist.
 *
 * So a performer claim is a real claim that an admin reviews. Slower, and the
 * honest shape for an entity whose ownership is recorded on the row itself.
 */
export default async function ClaimPerformerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const db = getCloudflareDb();

  const [performer] = await db
    .select({
      id: performers.id,
      name: performers.name,
      slug: performers.slug,
      claimed: performers.claimed,
    })
    .from(performers)
    .where(and(eq(performers.slug, unsafeSlug(slug)), isNull(performers.deletedAt)))
    .limit(1);

  if (!performer) notFound();

  const session = await auth();
  const name = decodeHtmlEntities(performer.name);
  const publicHref = `/performers/${performer.slug}`;

  // An already-claimed page says so instead of collecting evidence nobody will
  // action — a second claimant deserves a straight answer, not a form.
  if (performer.claimed) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="mb-1 text-2xl font-bold text-foreground">{name} is already claimed</h1>
        <p className="mb-6 text-muted-foreground">
          Someone has already verified they represent this act. If you believe that is wrong, reply
          to any of our emails or use the contact link and we will look into it.
        </p>
        <Link href={publicHref} className="text-navy hover:underline">
          View the page →
        </Link>
      </div>
    );
  }

  if (!session?.user?.id) {
    const callbackUrl = `/claim/performer/${performer.slug}`;
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="mb-1 text-2xl font-bold text-foreground">Claim this page</h1>
        <p className="mb-6 text-muted-foreground">
          Sign in or create an account to tell us you represent {name}.
        </p>
        <div className="flex gap-3">
          <Link
            href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="rounded-md bg-navy px-4 py-2 text-white"
          >
            Sign in
          </Link>
          <Link
            href={`/register?callbackUrl=${encodeURIComponent(callbackUrl)}`}
            className="rounded-md border border-border px-4 py-2 text-foreground"
          >
            Create an account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="mb-1 text-2xl font-bold text-foreground">Claim this page</h1>
      <p className="mb-6 text-muted-foreground">
        Tell us how you are connected to {name} and a person will review it. We will email you
        either way.
      </p>
      <ClaimEvidenceForm
        entityType="PERFORMER"
        slug={performer.slug as unknown as string}
        entityName={name}
      />
      <p className="mt-6 text-sm text-muted-foreground">
        <Link href={publicHref} className="text-navy hover:underline">
          ← Back to {name}
        </Link>
      </p>
    </div>
  );
}

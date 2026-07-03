import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq, count } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events } from "@/lib/db/schema";
import { unsafeSlug, decodeHtmlEntities } from "@/lib/utils";
import { isPublicEventStatus } from "@/lib/event-status";
import { ClaimWizard } from "@/components/claim/ClaimWizard";

export const metadata: Metadata = {
  title: "Claim your organization listing",
  // Claim funnels must never be indexed (OPE-43 posture for auth-adjacent flows).
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ClaimPromoterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getCloudflareDb();

  // NOTE: the promoters table has no viewCount column — the preview omits that
  // stat for promoters (the wizard guards on a null viewCount).
  const [promoter] = await db
    .select({
      id: promoters.id,
      companyName: promoters.companyName,
      slug: promoters.slug,
    })
    .from(promoters)
    .where(eq(promoters.slug, unsafeSlug(slug)))
    .limit(1);

  if (!promoter) notFound();

  const [session, linked] = await Promise.all([
    auth(),
    db
      .select({ n: count() })
      .from(events)
      .where(and(eq(events.promoterId, promoter.id), isPublicEventStatus())),
  ]);

  const name = decodeHtmlEntities(promoter.companyName);
  const isLoggedIn = !!session?.user?.id;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="mb-1 text-2xl font-bold text-foreground">Claim this listing</h1>
      <p className="mb-6 text-muted-foreground">
        Confirm you represent {name} to manage its events and public page.
      </p>
      <ClaimWizard
        entityType="PROMOTER"
        slug={promoter.slug as unknown as string}
        entityName={name}
        viewCount={null}
        linkedEventsCount={linked[0]?.n ?? 0}
        isLoggedIn={isLoggedIn}
        registerHref={`/register?role=PROMOTER&companyName=${encodeURIComponent(name)}&claim=${encodeURIComponent(
          promoter.slug as unknown as string
        )}`}
        loginHref={`/login?callbackUrl=${encodeURIComponent(`/claim/promoter/${promoter.slug}`)}`}
      />
    </div>
  );
}

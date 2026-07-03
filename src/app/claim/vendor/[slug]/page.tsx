import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, eq, isNull, countDistinct } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events } from "@/lib/db/schema";
import { unsafeSlug, decodeHtmlEntities } from "@/lib/utils";
import { isPublicEventStatus } from "@/lib/event-status";
import { ClaimWizard } from "@/components/claim/ClaimWizard";

export const metadata: Metadata = {
  title: "Claim your vendor listing",
  // Claim funnels must never be indexed (OPE-43 posture for auth-adjacent flows).
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ClaimVendorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getCloudflareDb();

  const [vendor] = await db
    .select({
      id: vendors.id,
      businessName: vendors.businessName,
      slug: vendors.slug,
      viewCount: vendors.viewCount,
    })
    .from(vendors)
    .where(and(eq(vendors.slug, unsafeSlug(slug)), isNull(vendors.deletedAt)))
    .limit(1);

  if (!vendor) notFound();

  const [session, linked] = await Promise.all([
    auth(),
    db
      .select({ n: countDistinct(eventVendors.eventId) })
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .where(and(eq(eventVendors.vendorId, vendor.id), isPublicEventStatus())),
  ]);

  const name = decodeHtmlEntities(vendor.businessName);
  const isLoggedIn = !!session?.user?.id;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="mb-1 text-2xl font-bold text-foreground">Claim this listing</h1>
      <p className="mb-6 text-muted-foreground">
        Confirm you represent {name} to manage its public page.
      </p>
      <ClaimWizard
        entityType="VENDOR"
        slug={vendor.slug as unknown as string}
        entityName={name}
        viewCount={vendor.viewCount ?? 0}
        linkedEventsCount={linked[0]?.n ?? 0}
        isLoggedIn={isLoggedIn}
        registerHref={`/register?role=VENDOR&businessName=${encodeURIComponent(name)}&claim=${encodeURIComponent(
          vendor.slug as unknown as string
        )}`}
        loginHref={`/login?callbackUrl=${encodeURIComponent(`/claim/vendor/${vendor.slug}`)}`}
      />
    </div>
  );
}

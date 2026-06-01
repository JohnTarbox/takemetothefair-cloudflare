import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  Globe,
  CheckCircle,
  Calendar,
  MapPin,
  Pencil,
  Mail,
  Phone,
  User,
  CreditCard,
  Building,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { decodeHtmlEntities, formatDateRange, unsafeSlug } from "@/lib/utils";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, users, eventVendors, events, venues, vendorSlugHistory } from "@/lib/db/schema";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { VendorGallery, type GalleryImage } from "@/components/vendors/VendorGallery";
import { VendorContactForm } from "@/components/vendors/VendorContactForm";
import { VendorTypeIcon } from "@/components/vendors/VendorTypeIcon";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { parseVendorSocialLinks } from "@/lib/vendor-social";
import { isVendorIndexable } from "@/lib/vendor-quality";
import { parseJsonArray } from "@/types";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { logError } from "@/lib/logger";
import { buildVendorMetaDescription } from "@/lib/seo-utils";
import { getDirectlyLinkedBlogPosts } from "@/lib/content-links-query";
import { VendorSchema } from "@/components/seo/VendorSchema";
import { VendorTierBadges } from "@/components/vendors/VendorTierBadges";
import { VendorProfileCompleteness } from "@/components/vendor/profile-completeness";
import { ClaimListingCTA } from "@/components/vendors/ClaimListingCTA";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { DetailPageTracker } from "@/components/DetailPageTracker";
import { ScrollDepthTracker } from "@/components/ScrollDepthTracker";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Walks vendor_slug_history to find the current slug for a moved vendor.
 * Returns null if the input slug isn't a known historical slug. Follows
 * chains up to MAX_HOPS in case of consecutive renames.
 */
async function findCurrentSlugForOld(slug: string): Promise<string | null> {
  const db = getCloudflareDb();
  const MAX_HOPS = 5;
  let cursor = slug;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const rows = await db
      .select({ newSlug: vendorSlugHistory.newSlug })
      .from(vendorSlugHistory)
      .where(eq(vendorSlugHistory.oldSlug, unsafeSlug(cursor)))
      .orderBy(desc(vendorSlugHistory.changedAt))
      .limit(1);
    if (rows.length === 0) {
      // We've followed the chain to its end. cursor is either the original
      // slug (no hops happened) or the latest known new_slug.
      return hop === 0 ? null : cursor;
    }
    cursor = rows[0].newSlug;
  }
  return cursor;
}

async function getVendor(slug: string) {
  const db = getCloudflareDb();

  try {
    // Get vendor with user
    const vendorResults = await db
      .select()
      .from(vendors)
      .leftJoin(users, eq(vendors.userId, users.id))
      .where(eq(vendors.slug, unsafeSlug(slug)))
      .limit(1);

    if (vendorResults.length === 0) return null;

    const vendor = vendorResults[0];

    // Get event vendors with events and venues. Filtered by public status
    // for display (Upcoming/Past Events sections only show APPROVED/CONFIRMED
    // associations). The §6.6 SEO predicate uses a separate, status-agnostic
    // count below so the page-level noindex matches the sitemap's gate
    // exactly — see commit ab17bc4 for the SQL it mirrors.
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(eq(eventVendors.vendorId, vendor.vendors.id), isPublicVendorStatus()))
      .orderBy(asc(events.startDate));

    const vendorEvents = eventVendorResults
      .filter((ev) => ev.events !== null)
      .map((ev) => ({
        ...ev.event_vendors,
        event: {
          ...ev.events!,
          venue: ev.venues ?? null,
        },
      }))
      .sort((a, b) => {
        const aTime = a.event.startDate ? new Date(a.event.startDate).getTime() : 0;
        const bTime = b.event.startDate ? new Date(b.event.startDate).getTime() : 0;
        return aTime - bTime;
      });

    // Status-agnostic counts for the §6.6 SEO predicate. Mirrors the SQL
    // gate in src/app/sitemap.ts so page noindex and sitemap inclusion
    // can never disagree for the same vendor.
    const [seoCounts] = await db
      .select({
        eventAssociationCount: sql<number>`COUNT(*)`,
        eventVenueGeoCount: sql<number>`SUM(
          CASE WHEN ${venues.city} IS NOT NULL AND ${venues.city} != ''
                AND ${venues.state} IS NOT NULL AND ${venues.state} != ''
               THEN 1 ELSE 0 END
        )`,
      })
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(eventVendors.vendorId, vendor.vendors.id));

    // Increment view count (drizzle/0051). Mirrors events/[slug]/page.tsx pattern.
    // ISR cache provides implicit ~5-min dedup; absolute count undercounts but
    // relative ordering (used by claimed_ready_for_enhanced_upsell rule) is preserved.
    await db
      .update(vendors)
      .set({ viewCount: sql`${vendors.viewCount} + 1` })
      .where(eq(vendors.id, vendor.vendors.id));

    return {
      ...vendor.vendors,
      user: vendor.users
        ? { name: vendor.users.name, email: vendor.users.email }
        : { name: null, email: null },
      eventVendors: vendorEvents,
      seoEventAssociationCount: Number(seoCounts?.eventAssociationCount ?? 0),
      seoEventVenueGeoCount: Number(seoCounts?.eventVenueGeoCount ?? 0),
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendor",
      error: e,
      source: "app/vendors/[slug]/page.tsx:getVendor",
      context: { slug },
    });
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const vendor = await getVendor(slug);

  if (!vendor) {
    return { title: "Vendor Not Found" };
  }

  const businessName = decodeHtmlEntities(vendor.businessName);
  const title = `${businessName} | Meet Me at the Fair`;
  const description = buildVendorMetaDescription(vendor);
  const url = `https://meetmeatthefair.com/vendors/${vendor.slug}`;
  // §6.6 SEO predicate. Uses status-agnostic counts (computed in getVendor)
  // to mirror the sitemap's SQL gate exactly — page noindex and sitemap
  // inclusion must never disagree for the same vendor.
  const indexable = isVendorIndexable({
    ...vendor,
    eventAssociationCount: vendor.seoEventAssociationCount,
    eventVenueGeoCount: vendor.seoEventVenueGeoCount,
  });

  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: businessName,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      images: [
        vendor.logoUrl
          ? { url: vendor.logoUrl, width: 400, height: 400, alt: businessName }
          : {
              url: "https://meetmeatthefair.com/og-default.png",
              width: 1200,
              height: 630,
              alt: businessName,
            },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: businessName,
      description,
      images: [vendor.logoUrl || "https://meetmeatthefair.com/og-default.png"],
    },
  };
}

export default async function VendorDetailPage({ params }: Props) {
  const { slug } = await params;
  const vendor = await getVendor(slug);

  if (!vendor) {
    // Before giving up, check the slug history table — if this URL was a
    // previous slug for an existing vendor, 301-redirect to the current.
    const currentSlug = await findCurrentSlugForOld(slug);
    if (currentSlug) {
      permanentRedirect(`/vendors/${currentSlug}`);
    }
    notFound();
  }

  // Soft-deleted vendor (drizzle/0053): if a redirect target is set and
  // still live, 301-redirect there. Otherwise the page should not render —
  // we cooperate with notFound() (returns 404) since Next.js App Router
  // doesn't have a built-in 410 response shape; the slug is "intentionally
  // gone" but Bing/Google will figure that out from the IndexNow ping that
  // fired at delete time. Bing in particular is fast at dropping these.
  if (vendor.deletedAt) {
    if (vendor.redirectToVendorId) {
      const db = getCloudflareDb();
      const [target] = await db
        .select({ slug: vendors.slug, deletedAt: vendors.deletedAt })
        .from(vendors)
        .where(eq(vendors.id, vendor.redirectToVendorId))
        .limit(1);
      if (target && !target.deletedAt) {
        permanentRedirect(`/vendors/${target.slug}`);
      }
    }
    notFound();
  }

  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";
  const isOwner = !!session?.user?.id && session.user.id === vendor.userId;

  // Direct-claim eligibility (PR 1) — when the signed-in visitor's
  // verified email matches the vendor's contact_email, the CTA renders
  // a one-click claim button instead of the standard register-redirect.
  // Server-side check: we need users.email_verified, which the session
  // doesn't carry — read it from D1 once for the small set of users
  // who could plausibly be eligible (session present, contact_email
  // present, looks similar).
  let eligibleForDirectClaim = false;
  if (
    !vendor.claimed &&
    session?.user?.id &&
    session.user.email &&
    vendor.contactEmail &&
    session.user.email.trim().toLowerCase() === vendor.contactEmail.trim().toLowerCase()
  ) {
    try {
      const db = getCloudflareDb();
      const [verifyRow] = await db
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
      eligibleForDirectClaim = !!verifyRow?.emailVerified;
    } catch {
      // If the verification lookup fails, fall back to the standard
      // claim flow rather than tempting fate with a one-click button
      // that might 401/403 on the server side.
      eligibleForDirectClaim = false;
    }
  }

  const linkedBlogPosts = await getDirectlyLinkedBlogPosts(
    getCloudflareDb(),
    "VENDOR",
    vendor.id,
    3
  );

  const now = new Date();
  const upcomingEvents = vendor.eventVendors.filter(
    (ev) => !ev.event.endDate || new Date(ev.event.endDate) >= now
  );
  const pastEvents = vendor.eventVendors.filter(
    (ev) => ev.event.endDate && new Date(ev.event.endDate) < now
  );

  const products = parseJsonArray(vendor.products);
  const paymentMethods = parseJsonArray(vendor.paymentMethods);

  // Enhanced Profile state — drives several render branches below.
  const isEnhanced = !!vendor.enhancedProfile;
  let galleryImages: GalleryImage[] = [];
  try {
    const parsed = JSON.parse(vendor.galleryImages || "[]");
    if (Array.isArray(parsed)) galleryImages = parsed.slice(0, 2);
  } catch {
    // malformed JSON in gallery_images; treat as empty rather than throw
  }
  const expiresAt = vendor.enhancedProfileExpiresAt
    ? new Date(vendor.enhancedProfileExpiresAt)
    : null;
  const inGrace = isEnhanced && expiresAt !== null && expiresAt.getTime() < now.getTime();

  return (
    <>
      <DetailPageTracker type="vendor" slug={vendor.slug} name={vendor.businessName} />
      <ScrollDepthTracker pageType="vendor-detail" />
      <VendorSchema
        businessName={vendor.businessName}
        description={vendor.description}
        logoUrl={vendor.logoUrl}
        url={`https://meetmeatthefair.com/vendors/${vendor.slug}`}
        address={vendor.address}
        city={vendor.city}
        state={vendor.state}
        zip={vendor.zip}
        telephone={vendor.contactPhone}
        email={vendor.contactEmail}
        website={vendor.website}
        yearEstablished={vendor.yearEstablished}
        paymentMethods={paymentMethods}
        socialLinks={vendor.socialLinks}
        products={products}
        galleryImageUrls={isEnhanced ? galleryImages.map((g) => g.url) : undefined}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Vendors", url: "https://meetmeatthefair.com/vendors" },
          { name: vendor.businessName, url: `https://meetmeatthefair.com/vendors/${vendor.slug}` },
        ]}
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <main className="lg:col-span-2 space-y-6">
            {isOwner && !isAdmin && session?.user?.id && (
              <VendorProfileCompleteness userId={session.user.id} />
            )}
            {isAdmin && inGrace && expiresAt && (
              <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
                Enhanced Profile expired {expiresAt.toISOString().slice(0, 10)} — features still
                visible during the 30-day grace period. Renew or it reverts in{" "}
                {Math.max(
                  0,
                  Math.ceil((expiresAt.getTime() + 30 * 86400000 - now.getTime()) / 86400000)
                )}{" "}
                days.
              </div>
            )}

            <div className="flex items-start gap-6">
              {isEnhanced ? (
                <div
                  className="w-[200px] h-[200px] rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0 relative overflow-hidden"
                  data-testid="vendor-logo-enhanced"
                >
                  {vendor.logoUrl ? (
                    <Image
                      src={vendor.logoUrl}
                      alt={vendor.businessName}
                      fill
                      sizes="200px"
                      className="object-cover rounded-xl"
                    />
                  ) : (
                    <VendorTypeIcon
                      vendorType={vendor.vendorType}
                      className="text-gray-600"
                      size={96}
                    />
                  )}
                </div>
              ) : (
                <div
                  className="w-24 h-24 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0"
                  data-testid="vendor-logo-free"
                >
                  <VendorTypeIcon
                    vendorType={vendor.vendorType}
                    className="text-gray-600"
                    size={48}
                  />
                </div>
              )}
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-3xl font-bold text-gray-900">{vendor.businessName}</h1>
                  {isEnhanced && vendor.verified && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 text-xs font-medium px-2 py-0.5"
                      title="This vendor has an active Enhanced Profile subscription on MMATF."
                    >
                      <CheckCircle className="w-3 h-3" />
                      Verified
                    </span>
                  )}
                  <VendorTierBadges
                    claimed={vendor.claimed}
                    enhancedProfile={vendor.enhancedProfile}
                    verifiedPro={vendor.verifiedPro}
                    className="inline-flex items-center gap-1.5"
                  />
                </div>
                {vendor.vendorType && (
                  <p className="mt-1 text-lg text-gray-600">{vendor.vendorType}</p>
                )}
                {isEnhanced && (
                  <div className="mt-3">
                    <VendorContactForm vendorSlug={vendor.slug} vendorName={vendor.businessName} />
                  </div>
                )}
              </div>
            </div>

            {isEnhanced && galleryImages.length > 0 && (
              <VendorGallery images={galleryImages} vendorName={vendor.businessName} />
            )}

            {vendor.description && (
              <div className="prose prose-gray max-w-none">
                <p className="text-gray-600 whitespace-pre-wrap">{vendor.description}</p>
              </div>
            )}

            {(() => {
              return (
                products.length > 0 && (
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 mb-3">
                      Products & Services
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {products.map((product) => (
                        <Badge key={product} variant="info">
                          {product}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )
              );
            })()}

            {upcomingEvents.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-gray-900">
                    Upcoming Events ({upcomingEvents.length})
                  </h2>
                  {vendor.eventVendors.length > 6 && (
                    <Link
                      href={`/vendors/${vendor.slug}/events`}
                      className="text-sm text-royal hover:text-navy font-medium"
                    >
                      View all events
                    </Link>
                  )}
                </div>
                <div className="space-y-3">
                  {upcomingEvents.slice(0, 6).map(({ event }) => (
                    <Card key={event.id} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4 flex items-center gap-4">
                        <Link
                          href={`/events/${event.slug}`}
                          className="w-16 h-16 rounded-lg bg-brand-blue-light flex flex-col items-center justify-center text-royal"
                        >
                          <Calendar className="w-6 h-6" />
                        </Link>
                        <div className="flex-1">
                          <Link href={`/events/${event.slug}`}>
                            <h3 className="font-medium text-gray-900 hover:text-navy">
                              {event.name}
                            </h3>
                          </Link>
                          <div className="flex items-center gap-2 text-sm text-gray-600">
                            <span>{formatDateRange(event.startDate, event.endDate)}</span>
                            <AddToCalendar
                              title={event.name}
                              description={event.description || undefined}
                              location={
                                event.venue
                                  ? `${event.venue.name}, ${event.venue.address || ""}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip || ""}`
                                  : undefined
                              }
                              startDate={event.startDate}
                              endDate={event.endDate}
                              url={`https://meetmeatthefair.com/events/${event.slug}`}
                              variant="icon"
                            />
                          </div>
                          {event.venue && (
                            <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />
                              {event.venue.name}, {event.venue.city}
                            </p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                {upcomingEvents.length > 6 && (
                  <div className="mt-4 text-center">
                    <Link
                      href={`/vendors/${vendor.slug}/events`}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-royal hover:text-navy hover:bg-brand-blue-light rounded-lg transition-colors"
                    >
                      View all {vendor.eventVendors.length} events
                    </Link>
                  </div>
                )}
              </div>
            )}

            {pastEvents.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-gray-900">
                    Past Events ({pastEvents.length})
                  </h2>
                  {pastEvents.length > 5 && (
                    <Link
                      href={`/vendors/${vendor.slug}/events?filter=past`}
                      className="text-sm text-royal hover:text-navy font-medium"
                    >
                      View all past events
                    </Link>
                  )}
                </div>
                <div className="space-y-3">
                  {pastEvents.slice(0, 5).map(({ event }) => (
                    <Link key={event.id} href={`/events/${event.slug}`}>
                      <Card className="hover:shadow-md transition-shadow opacity-75">
                        <CardContent className="p-4 flex items-center gap-4">
                          <div className="w-16 h-16 rounded-lg bg-gray-100 flex flex-col items-center justify-center text-gray-600">
                            <Calendar className="w-6 h-6" />
                          </div>
                          <div className="flex-1">
                            <h3 className="font-medium text-gray-700">{event.name}</h3>
                            <p className="text-sm text-gray-500">
                              {formatDateRange(event.startDate, event.endDate)}
                            </p>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
                {pastEvents.length > 5 && (
                  <div className="mt-4 text-center">
                    <Link
                      href={`/vendors/${vendor.slug}/events`}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-royal hover:text-navy hover:bg-brand-blue-light rounded-lg transition-colors"
                    >
                      View all {pastEvents.length} past events
                    </Link>
                  </div>
                )}
              </div>
            )}
          </main>

          <aside className="space-y-6">
            {isAdmin && (
              <Card>
                <CardContent className="p-6">
                  <Link href={`/admin/vendors/${vendor.id}/edit`}>
                    <Button variant="outline" className="w-full">
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit Vendor
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )}

            {!vendor.claimed && !isOwner && !isAdmin && (
              <ClaimListingCTA
                businessName={vendor.businessName}
                vendorSlug={vendor.slug}
                eligibleForDirectClaim={eligibleForDirectClaim}
              />
            )}

            <Card>
              <CardHeader>
                <h3 className="font-semibold text-gray-900">Contact & Links</h3>
              </CardHeader>
              <CardContent className="space-y-3">
                {vendor.contactName && (
                  <div className="flex items-center gap-3 text-gray-700">
                    <User className="w-5 h-5 text-gray-600" />
                    {vendor.contactName}
                  </div>
                )}
                {vendor.contactEmail && (
                  <a
                    href={`mailto:${vendor.contactEmail}`}
                    className="flex items-center gap-3 text-gray-700 hover:text-navy"
                  >
                    <Mail className="w-5 h-5 text-royal" />
                    {vendor.contactEmail}
                  </a>
                )}
                {vendor.contactPhone && (
                  <a
                    href={`tel:${vendor.contactPhone}`}
                    className="flex items-center gap-3 text-gray-700 hover:text-navy"
                  >
                    <Phone className="w-5 h-5 text-royal" />
                    {vendor.contactPhone}
                  </a>
                )}
                {vendor.website && (
                  <a
                    href={vendor.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 text-gray-700 hover:text-navy"
                  >
                    <Globe className="w-5 h-5 text-royal" />
                    Visit Website
                  </a>
                )}
                {Object.entries(parseVendorSocialLinks(vendor.socialLinks)).map(
                  ([platform, url]) => (
                    <a
                      key={platform}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 text-gray-700 hover:text-navy capitalize"
                    >
                      {platform}
                    </a>
                  )
                )}
              </CardContent>
            </Card>

            {/* Location Card */}
            {(vendor.address || vendor.city) && (
              <Card>
                <CardHeader>
                  <h3 className="font-semibold text-gray-900">Location</h3>
                </CardHeader>
                <CardContent>
                  <div className="flex items-start gap-3 text-gray-700">
                    <MapPin className="w-5 h-5 text-gray-600 mt-0.5" />
                    <div>
                      {vendor.address && <div>{vendor.address}</div>}
                      {(vendor.city || vendor.state || vendor.zip) && (
                        <div>
                          {[vendor.city, vendor.state].filter(Boolean).join(", ")}
                          {vendor.zip && ` ${vendor.zip}`}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Business Details Card */}
            {(vendor.yearEstablished || vendor.paymentMethods) && (
              <Card>
                <CardHeader>
                  <h3 className="font-semibold text-gray-900">Business Details</h3>
                </CardHeader>
                <CardContent className="space-y-3">
                  {vendor.yearEstablished && (
                    <div className="flex items-center gap-3 text-gray-700">
                      <Building className="w-5 h-5 text-gray-600" />
                      <span>Est. {vendor.yearEstablished}</span>
                    </div>
                  )}
                  {(() => {
                    return (
                      paymentMethods.length > 0 && (
                        <div className="flex items-start gap-3 text-gray-700">
                          <CreditCard className="w-5 h-5 text-gray-600 mt-0.5" />
                          <div className="flex flex-wrap gap-1">
                            {paymentMethods.map((method) => (
                              <Badge key={method} variant="default" className="text-xs">
                                {method}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="p-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-gray-900">{vendor.eventVendors.length}</p>
                  <p className="text-sm text-gray-600">Total Events Attended</p>
                </div>
              </CardContent>
            </Card>

            {linkedBlogPosts.length > 0 && (
              <Card>
                <CardHeader>
                  <h3 className="font-semibold text-gray-900">Written about this vendor</h3>
                </CardHeader>
                <CardContent className="space-y-3">
                  {linkedBlogPosts.map((post) => (
                    <Link
                      key={post.slug}
                      href={`/blog/${post.slug}`}
                      className="block p-3 rounded-lg border border-stone-100 hover:border-amber hover:bg-amber-light/40 transition-colors"
                    >
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 mb-1 rounded-full text-[11px] font-medium bg-amber-light text-amber-dark">
                        Written about this vendor
                      </span>
                      <p className="font-medium text-gray-900 line-clamp-2">{post.title}</p>
                      {post.excerpt && (
                        <p className="text-sm text-gray-500 mt-1 line-clamp-2">{post.excerpt}</p>
                      )}
                    </Link>
                  ))}
                </CardContent>
              </Card>
            )}
          </aside>
        </div>

        {/* Bottom-of-page link to the public Vendor Guide. Shown only on
            verified vendors' pages (Enhanced Profile + the verified flag)
            — these are the listings most likely to be visited by other
            vendors weighing whether to sign up themselves, so the guide
            is most useful here. Add a wider audience for the link if
            needed; today this is the minimal-friction placement. */}
        {isEnhanced && vendor.verified && (
          <div className="mt-12 border-t border-gray-200 pt-8 text-center">
            <p className="text-sm text-gray-600">
              Are you a vendor?{" "}
              <Link
                href="/vendor-guide"
                className="font-medium text-royal hover:text-navy underline"
              >
                Read the Vendor Guide
              </Link>{" "}
              to sign up, claim your listing, and edit your profile.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

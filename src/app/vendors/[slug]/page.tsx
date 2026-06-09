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
import {
  vendors,
  users,
  eventVendors,
  events,
  venues,
  eventDays,
  vendorSlugHistory,
} from "@/lib/db/schema";
import { formatOccurrenceDate } from "@/lib/k18-vendor-grouping";
import { eq, ne, and, or, asc, desc, sql, isNull } from "drizzle-orm";
import { VendorGallery, type GalleryImage } from "@/components/vendors/VendorGallery";
import { VendorContactForm } from "@/components/vendors/VendorContactForm";
import { VendorMonogramLogo } from "@/components/vendors/VendorMonogramLogo";
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
import { canonicalParentSlugFor, type DisplayableParent } from "@/lib/vendor-hierarchy";
import { cdnImage, OG_EVENT, OG_SQUARE } from "@/lib/cdn-image";

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
    //
    // Narrow venues projection (P3a aftermath, 2026-06-06): before P3a this
    // join's bare .select() returned 9 (event_vendors) + 62 (events) + 27
    // (venues) = 98 columns — just under D1's 100-col result-row cap. P3a
    // added 3 columns to venues (timezone/locale/country, drizzle/0112),
    // tipping the total to 101 and silently returning no rows from D1 →
    // every vendor detail page rendered "Vendor Not Found" until this fix.
    // Per memory feedback_d1_100_col_result_cap, the response is to narrow
    // the projection. Downstream consumers in this file only access venue
    // name/address/city/state/zip (lines 703, 715); narrowing to those keeps
    // total cols at 9 + 62 + 6 = 77.
    // K18 Phase 2 (drizzle/0114, 2026-06-06): LEFT JOIN event_days so the
    // per-occurrence date string is available without a second roundtrip.
    // event_day_id IS NULL for series-wide links -> the LEFT JOIN yields
    // NULL for eventDayDate, which the render path interprets as "regular
    // participant" (no per-date subtitle).
    const eventVendorResults = await db
      .select({
        event_vendors: eventVendors,
        events: events,
        venues: {
          id: venues.id,
          name: venues.name,
          address: venues.address,
          city: venues.city,
          state: venues.state,
          zip: venues.zip,
        },
        eventDayDate: eventDays.date,
      })
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(eventDays, eq(eventVendors.eventDayId, eventDays.id))
      .where(and(eq(eventVendors.vendorId, vendor.vendors.id), isPublicVendorStatus()))
      .orderBy(asc(events.startDate));

    // Aggregate by event.id: collapse multiple (event, vendor) links
    // (e.g. series-wide PLUS a per-day link) into a single per-event row
    // carrying an `occurrenceDates` array. Series-wide-only events get an
    // empty occurrenceDates array; per-day-only or mixed events list the
    // distinct dates the vendor is scoped to.
    type EventWithVenue = NonNullable<(typeof eventVendorResults)[number]["events"]> & {
      venue: (typeof eventVendorResults)[number]["venues"] | null;
    };
    interface VendorEventEntry {
      event: EventWithVenue;
      // The "lead" link row, preserved for the existing fields the render
      // reads (status, paymentStatus, participationType, etc.).
      event_vendors: (typeof eventVendorResults)[number]["event_vendors"];
      /** Distinct per-day dates (YYYY-MM-DD) this vendor is scoped to for
       *  this event, sorted chronologically. Empty -> series-wide only. */
      occurrenceDates: string[];
      /** True when ANY link for this (event, vendor) is series-wide. */
      hasSeriesWide: boolean;
    }
    const byEventId = new Map<string, VendorEventEntry>();
    for (const row of eventVendorResults) {
      if (!row.events) continue;
      const eid = row.events.id;
      const existing = byEventId.get(eid);
      if (existing) {
        if (row.event_vendors.eventDayId == null) {
          existing.hasSeriesWide = true;
        } else if (row.eventDayDate && !existing.occurrenceDates.includes(row.eventDayDate)) {
          existing.occurrenceDates.push(row.eventDayDate);
        }
      } else {
        const isSeriesWide = row.event_vendors.eventDayId == null;
        byEventId.set(eid, {
          event: { ...row.events, venue: row.venues ?? null },
          event_vendors: row.event_vendors,
          occurrenceDates: !isSeriesWide && row.eventDayDate ? [row.eventDayDate] : [],
          hasSeriesWide: isSeriesWide,
        });
      }
    }
    const vendorEvents = [...byEventId.values()]
      .map((e) => ({
        ...e.event_vendors,
        event: e.event,
        occurrenceDates: [...e.occurrenceDates].sort((a, b) => a.localeCompare(b)),
        hasSeriesWide: e.hasSeriesWide,
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

    // EH1 Phase 1 — load hierarchy context so render + canonical can resolve.
    // LOCAL_OFFICE → fetch the brand parent row (drives resolveVendorDisplay)
    //                AND the operator parent row if set (drives the
    //                'operator_parent' / 'both' display modes).
    // NATIONAL    → fetch the children list (rendered as a "Local Offices"
    //                section instead of the standard Events sections).
    // INDEPENDENT → neither query runs. Most vendors hit this branch, so the
    //                hierarchy work is paid only when a hierarchy exists.
    type ParentRow = {
      id: string;
      slug: string;
      role: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
      defaultChildDisplay: "self" | "brand_parent" | "both" | null;
      businessName: string;
    };
    let brandParent: ParentRow | null = null;
    let operatorParent: ParentRow | null = null;
    let children: Array<{
      id: string;
      slug: string;
      businessName: string;
      city: string | null;
      state: string | null;
      contactPhone: string | null;
      contactEmail: string | null;
      vendorType: string | null;
      logoUrl: string | null;
    }> = [];

    if (vendor.vendors.role === "LOCAL_OFFICE" && vendor.vendors.brandParentVendorId) {
      const [parentRow] = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          role: vendors.role,
          defaultChildDisplay: vendors.defaultChildDisplay,
          businessName: vendors.businessName,
        })
        .from(vendors)
        .where(and(eq(vendors.id, vendor.vendors.brandParentVendorId), isNull(vendors.deletedAt)))
        .limit(1);
      if (parentRow) brandParent = parentRow;
    }
    // Operator parent is independent of brand parent — Shape C (Esler-run RbA
    // franchises) sets both; Shape A (LeafFilter, Goodhue) sets operator =
    // brand; an agent shape (NY Life) may have brand only. Only load when
    // distinct from the brand to avoid a duplicate self-query.
    if (
      vendor.vendors.role === "LOCAL_OFFICE" &&
      vendor.vendors.operatorParentVendorId &&
      vendor.vendors.operatorParentVendorId !== vendor.vendors.brandParentVendorId
    ) {
      const [opRow] = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          role: vendors.role,
          defaultChildDisplay: vendors.defaultChildDisplay,
          businessName: vendors.businessName,
        })
        .from(vendors)
        .where(
          and(eq(vendors.id, vendor.vendors.operatorParentVendorId), isNull(vendors.deletedAt))
        )
        .limit(1);
      if (opRow) operatorParent = opRow;
    }
    if (vendor.vendors.role === "NATIONAL") {
      children = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          businessName: vendors.businessName,
          city: vendors.city,
          state: vendors.state,
          contactPhone: vendors.contactPhone,
          contactEmail: vendors.contactEmail,
          vendorType: vendors.vendorType,
          logoUrl: vendors.logoUrl,
        })
        .from(vendors)
        .where(and(eq(vendors.brandParentVendorId, vendor.vendors.id), isNull(vendors.deletedAt)))
        .orderBy(asc(vendors.state), asc(vendors.city), asc(vendors.businessName));
    }

    return {
      ...vendor.vendors,
      user: vendor.users
        ? { name: vendor.users.name, email: vendor.users.email }
        : { name: null, email: null },
      eventVendors: vendorEvents,
      seoEventAssociationCount: Number(seoCounts?.eventAssociationCount ?? 0),
      seoEventVenueGeoCount: Number(seoCounts?.eventVenueGeoCount ?? 0),
      parent: brandParent,
      operatorParent,
      children,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendor",
      error: e,
      source: "app/vendors/[slug]/page.tsx:getVendor",
      context: { slug },
    });
    // K2 (2026-06-06): throw FetchError so error.tsx renders + HTTP 500
    // bubbles to the edge. Previously this returned null, which the page
    // component routed to notFound() (HTTP 404) — making D1 failures look
    // like "vendor doesn't exist" rather than the transient outage they
    // really are. The empty-results case (rows.length === 0 → return null
    // INSIDE the try block) is still a legitimate 404 and stays unchanged.
    // Mirrors REL1' §1 pattern in venues/[slug]/page.tsx.
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/vendors/[slug]/page.tsx:getVendor", e);
  }
}

/**
 * UX-A2 Part A — "Similar vendors nearby" module.
 *
 * Spec: "so the page is never a dead end."
 *
 * Resolution priority:
 *   1. Same vendor_type AND same city — strongest match
 *   2. Same vendor_type (any city) — fills the slot when town-mates
 *      don't exist
 *   3. Same city (any type) — last-resort filler so the module always
 *      has something to show on a vendor with no peers in either axis
 *
 * Excludes self + soft-deleted rows. Caps at 4 results, sorted by
 * claimed-first then by event-vendor count (popularity proxy).
 */
async function getSimilarVendors(vendorId: string, vendorType: string | null, city: string | null) {
  const db = getCloudflareDb();
  try {
    const rows = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        businessName: vendors.businessName,
        vendorType: vendors.vendorType,
        city: vendors.city,
        state: vendors.state,
        logoUrl: vendors.logoUrl,
        imageFocalX: vendors.imageFocalX,
        imageFocalY: vendors.imageFocalY,
        claimed: vendors.claimed,
      })
      .from(vendors)
      .where(
        and(
          ne(vendors.id, vendorId),
          isNull(vendors.deletedAt),
          // Match on EITHER type OR city; the priority-sort below
          // surfaces type-and-city dual-matches first when both apply.
          or(
            vendorType ? eq(vendors.vendorType, vendorType) : sql`0=1`,
            city ? eq(vendors.city, city) : sql`0=1`
          )
        )
      )
      .limit(12); // Over-fetch so we can prioritize-sort in JS to 4.

    // Score each candidate so dual-matches (type AND city) sort above
    // single-axis matches, with claimed vendors as a tertiary breaker.
    const scored = rows.map((v) => {
      let score = 0;
      if (vendorType && v.vendorType === vendorType) score += 2;
      if (city && v.city === city) score += 2;
      if (v.claimed) score += 1;
      return { ...v, _score: score };
    });
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, 4);
  } catch (e) {
    await logError(db, {
      message: "Error fetching similar vendors",
      error: e,
      source: "app/vendors/[slug]/page.tsx:getSimilarVendors",
    });
    // Non-throwing: similar-vendors is best-effort. Empty array → the
    // module just doesn't render. The page is still useful without it.
    return [];
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

  // EH1 Phase 1 — if this is a LOCAL_OFFICE that resolves to a non-self mode
  // ('brand_parent' or 'operator_parent'), canonical-up to that parent and
  // emit noindex on the office page. 'both' and 'self' keep the office page
  // as its own canonical (no canonical-up). The page still loads — deep
  // links and operator URLs keep working — but search engines treat the
  // parent as the indexed surface for the non-self modes.
  const parentForResolution: DisplayableParent | null = vendor.parent
    ? {
        id: vendor.parent.id,
        role: vendor.parent.role,
        defaultChildDisplay: vendor.parent.defaultChildDisplay,
      }
    : null;
  const canonicalUpSlug = canonicalParentSlugFor(
    vendor,
    parentForResolution,
    vendor.parent?.slug ?? null,
    vendor.operatorParent?.slug ?? null
  );
  const canonicalUrl = canonicalUpSlug
    ? `https://meetmeatthefair.com/vendors/${canonicalUpSlug}`
    : url;
  // Canonical-up implies noindex on the office page (parent owns the search
  // surface). Falls through to the §6.6 indexable predicate otherwise.
  const robotsValue = canonicalUpSlug
    ? { index: false, follow: true }
    : indexable
      ? undefined
      : { index: false, follow: true };

  return {
    title,
    description,
    robots: robotsValue,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: businessName,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      // IMG1 (2026-06-07) — sized derivatives for both branches.
      // Vendor logos use OG_SQUARE (1200×1200) since most vendor "images"
      // are square logos that would crop badly into 1200×630. Square OG
      // shows correctly in Slack/iMessage previews and FB/LinkedIn
      // letterbox cleanly. Vendors without a logo fall back to the
      // landscape og-default at OG_EVENT (1200×630).
      images: [
        vendor.logoUrl
          ? {
              url: cdnImage(vendor.logoUrl, OG_SQUARE),
              width: 1200,
              height: 1200,
              alt: businessName,
            }
          : {
              url: cdnImage("https://meetmeatthefair.com/og-default.png", OG_EVENT),
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
      images: [
        cdnImage(
          vendor.logoUrl || "https://meetmeatthefair.com/og-default.png",
          vendor.logoUrl ? OG_SQUARE : OG_EVENT
        ),
      ],
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

  // UX-A2 Part A — similar vendors (best-effort, never throws).
  // Sequential after vendor fetch because we need vendorType + city
  // from the fetched row; parallel would re-fetch. Cost: one extra
  // tiny query on render (≤12 rows projected). Acceptable for the
  // payoff of "never a dead-end page".
  const similarVendors = await getSimilarVendors(vendor.id, vendor.vendorType, vendor.city);

  // EH1 Phase 2 — render-time hierarchy switch.
  // Today only the NATIONAL hub branch alters JSX; canonical-up'd LOCAL_OFFICE
  // pages still render normally and just lean on the noindex/canonical from
  // generateMetadata to consolidate SEO equity. The "Part of <brand>" link
  // in the header serves every LOCAL_OFFICE regardless of canonical state.
  const isNationalHub = vendor.role === "NATIONAL";

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
              {/* UX-A2 Part A (2026-06-08) — monogram-tile placeholder
                  when there's no uploaded logo. Pre-fix this rendered a
                  generic Lucide Store/category icon over bg-muted —
                  visually identical to a broken image, contributing to
                  the "page looks abandoned" pattern that drove the
                  1-of-2533 claim rate. See VendorMonogramLogo for the
                  hash-stable color palette + initials logic. */}
              {isEnhanced ? (
                <div
                  className="w-[200px] h-[200px] rounded-xl flex-shrink-0 relative overflow-hidden"
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
                    <VendorMonogramLogo businessName={vendor.businessName} size={200} />
                  )}
                </div>
              ) : (
                <div className="w-24 h-24 rounded-xl flex-shrink-0" data-testid="vendor-logo-free">
                  <VendorMonogramLogo businessName={vendor.businessName} size={96} />
                </div>
              )}
              <div>
                {/* EH1 Phase 1 — relationship surface on LOCAL_OFFICE pages.
                    Renders for every office (not just canonical-up'd ones)
                    because the relationship is true regardless of which
                    surface is canonical. When an operator parent is
                    distinct from the brand parent (Shape C — Esler-run RbA
                    franchises, Bath Fitter / Premier Bath), surface both
                    relationships so the operator portfolio is discoverable
                    while the brand stays the primary association. */}
                {vendor.role === "LOCAL_OFFICE" && vendor.parent && (
                  <p className="text-sm text-muted-foreground mb-1">
                    Part of{" "}
                    <Link
                      href={`/vendors/${vendor.parent.slug}`}
                      className="text-royal hover:text-navy font-medium underline"
                    >
                      {decodeHtmlEntities(vendor.parent.businessName)}
                    </Link>
                    {vendor.operatorParent && (
                      <>
                        {" "}
                        · operated by{" "}
                        <Link
                          href={`/vendors/${vendor.operatorParent.slug}`}
                          className="text-royal hover:text-navy font-medium underline"
                        >
                          {decodeHtmlEntities(vendor.operatorParent.businessName)}
                        </Link>
                      </>
                    )}
                  </p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-3xl font-bold text-foreground">{vendor.businessName}</h1>
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
                  <p className="mt-1 text-lg text-muted-foreground">{vendor.vendorType}</p>
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
                <p className="text-muted-foreground whitespace-pre-wrap">{vendor.description}</p>
              </div>
            )}

            {(() => {
              return (
                products.length > 0 && (
                  <div>
                    <h2 className="text-xl font-semibold text-foreground mb-3">
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

            {/* EH1 Phase 2 — NATIONAL hub renders a "Local Offices" section
                instead of events. National parents typically have no event
                associations (events apply to franchises, not the brand),
                so swapping the section avoids a sad-empty Events block. */}
            {isNationalHub && vendor.children.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-foreground">
                    Local Offices ({vendor.children.length})
                  </h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {vendor.children.map((child) => (
                    <Link key={child.id} href={`/vendors/${child.slug}`} className="block">
                      <Card className="hover:shadow-md transition-shadow h-full">
                        <CardContent className="p-4">
                          <h3 className="font-medium text-foreground hover:text-navy">
                            {decodeHtmlEntities(child.businessName)}
                          </h3>
                          {(child.city || child.state) && (
                            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />
                              {[child.city, child.state].filter(Boolean).join(", ")}
                            </p>
                          )}
                          {child.contactPhone && (
                            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                              <Phone className="w-3 h-3" />
                              {child.contactPhone}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {/* NATIONAL hub with no children yet — render a gentle empty
                state instead of leaving the main column visually bare. */}
            {isNationalHub && vendor.children.length === 0 && (
              <div className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">
                No local offices listed yet.
              </div>
            )}

            {!isNationalHub && upcomingEvents.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-foreground">
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
                  {upcomingEvents.slice(0, 6).map((ve) => {
                    const { event } = ve;
                    // K18 Phase 2 (2026-06-06): when the vendor has per-day
                    // links for this event, show the specific occurrence
                    // dates next to the event name. hasSeriesWide && per-day
                    // -> "regular participant, with featured slots on ..."
                    // per-day only -> just the dates. Series-wide only ->
                    // omit (today's behavior).
                    const hasPerDay = ve.occurrenceDates.length > 0;
                    const occurrenceLabel = hasPerDay
                      ? ve.occurrenceDates.map(formatOccurrenceDate).join(", ")
                      : null;
                    return (
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
                              <h3 className="font-medium text-foreground hover:text-navy">
                                {event.name}
                              </h3>
                            </Link>
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
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
                                eventSlug={event.slug}
                              />
                            </div>
                            {occurrenceLabel && (
                              <p className="text-sm text-foreground mt-1">
                                {ve.hasSeriesWide ? (
                                  <>Regular participant + featured: {occurrenceLabel}</>
                                ) : (
                                  <>Attending: {occurrenceLabel}</>
                                )}
                              </p>
                            )}
                            {event.venue && (
                              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                                <MapPin className="w-3 h-3" />
                                {event.venue.name}, {event.venue.city}
                              </p>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
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

            {!isNationalHub && pastEvents.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-foreground">
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
                          <div className="w-16 h-16 rounded-lg bg-muted flex flex-col items-center justify-center text-muted-foreground">
                            <Calendar className="w-6 h-6" />
                          </div>
                          <div className="flex-1">
                            <h3 className="font-medium text-foreground">{event.name}</h3>
                            <p className="text-sm text-muted-foreground">
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

            {/* UX-A2 Part A — "Similar vendors nearby" module.
                Spec: "so the page is never a dead end." Surfaces same-
                category and/or same-town vendors. Hidden when the
                lookup returns empty (best-effort, never blocks render). */}
            {similarVendors.length > 0 && (
              <div className="mt-8">
                <h2 className="text-xl font-semibold text-foreground mb-4">
                  Similar vendors
                  {vendor.city && (
                    <span className="text-base font-normal text-muted-foreground">
                      {" "}
                      — {vendor.vendorType ? `more ${vendor.vendorType.toLowerCase()}s` : "more"}
                      {vendor.city && ` in ${vendor.city}, ${vendor.state}`}
                    </span>
                  )}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {similarVendors.map((sv) => (
                    <Link
                      key={sv.id}
                      href={`/vendors/${sv.slug}`}
                      className="rounded-xl border border-border bg-card hover:shadow-md hover:-translate-y-0.5 transition-all p-4 flex items-center gap-3"
                    >
                      <div className="flex-shrink-0">
                        {sv.logoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={cdnImage(sv.logoUrl, {
                              width: 56,
                              height: 56,
                              fit: "cover",
                              format: "auto",
                              quality: 80,
                              onerror: "redirect",
                            })}
                            alt={`${sv.businessName} logo`}
                            width={56}
                            height={56}
                            loading="lazy"
                            decoding="async"
                            className="w-14 h-14 rounded-lg object-cover"
                          />
                        ) : (
                          <VendorMonogramLogo
                            businessName={sv.businessName}
                            size={56}
                            className="!rounded-lg"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground truncate">{sv.businessName}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {sv.vendorType}
                          {sv.city && sv.state && ` · ${sv.city}, ${sv.state}`}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
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
                <h3 className="font-semibold text-foreground">Contact & Links</h3>
              </CardHeader>
              <CardContent className="space-y-3">
                {vendor.contactName && (
                  <div className="flex items-center gap-3 text-foreground">
                    <User className="w-5 h-5 text-muted-foreground" />
                    {vendor.contactName}
                  </div>
                )}
                {vendor.contactEmail && (
                  <a
                    href={`mailto:${vendor.contactEmail}`}
                    className="flex items-center gap-3 text-foreground hover:text-navy"
                  >
                    <Mail className="w-5 h-5 text-royal" />
                    {vendor.contactEmail}
                  </a>
                )}
                {vendor.contactPhone && (
                  <a
                    href={`tel:${vendor.contactPhone}`}
                    className="flex items-center gap-3 text-foreground hover:text-navy"
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
                    className="flex items-center gap-3 text-foreground hover:text-navy"
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
                      className="flex items-center gap-3 text-foreground hover:text-navy capitalize"
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
                  <h3 className="font-semibold text-foreground">Location</h3>
                </CardHeader>
                <CardContent>
                  <div className="flex items-start gap-3 text-foreground">
                    <MapPin className="w-5 h-5 text-muted-foreground mt-0.5" />
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

            {/* Business Details Card.
             *
             * UX-A2 Part A (2026-06-08) — collapse-when-empty fix.
             * Pre-fix the guard checked `vendor.paymentMethods` (the raw
             * JSON string), which is truthy as `"[]"` even when empty —
             * so the card rendered with no content on most unclaimed
             * vendors. Now uses the parsed `paymentMethods` array's
             * length, matching the inner `paymentMethods.length > 0`
             * check, so the card only appears when something will go
             * inside it. Per MMATF-UIUX-VendorClaim-Spec §A:
             * "Collapse empty modules — don't render an empty
             * 'Business Details' card". */}
            {(vendor.yearEstablished || paymentMethods.length > 0) && (
              <Card>
                <CardHeader>
                  <h3 className="font-semibold text-foreground">Business Details</h3>
                </CardHeader>
                <CardContent className="space-y-3">
                  {vendor.yearEstablished && (
                    <div className="flex items-center gap-3 text-foreground">
                      <Building className="w-5 h-5 text-muted-foreground" />
                      <span>Est. {vendor.yearEstablished}</span>
                    </div>
                  )}
                  {(() => {
                    return (
                      paymentMethods.length > 0 && (
                        <div className="flex items-start gap-3 text-foreground">
                          <CreditCard className="w-5 h-5 text-muted-foreground mt-0.5" />
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

            {/* EH1 Phase 2 — skip the events-attended counter on NATIONAL
                hubs (national parents own no event_vendors rows, so it would
                always show 0). The hub's "Local Offices" main-column section
                already conveys size. */}
            {!isNationalHub && (
              <Card>
                <CardContent className="p-6">
                  <div className="text-center">
                    <p className="text-3xl font-bold text-foreground">
                      {vendor.eventVendors.length}
                    </p>
                    <p className="text-sm text-muted-foreground">Total Events Attended</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {linkedBlogPosts.length > 0 && (
              <Card>
                <CardHeader>
                  <h3 className="font-semibold text-foreground">Written about this vendor</h3>
                </CardHeader>
                <CardContent className="space-y-3">
                  {linkedBlogPosts.map((post) => (
                    <Link
                      key={post.slug}
                      href={`/blog/${post.slug}`}
                      className="block p-3 rounded-lg border border-border hover:border-amber hover:bg-amber-light/40 transition-colors"
                    >
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 mb-1 rounded-full text-[11px] font-medium bg-amber-light text-amber-bg-fg">
                        Written about this vendor
                      </span>
                      <p className="font-medium text-foreground line-clamp-2">{post.title}</p>
                      {post.excerpt && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {post.excerpt}
                        </p>
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
          <div className="mt-12 border-t border-border pt-8 text-center">
            <p className="text-sm text-muted-foreground">
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

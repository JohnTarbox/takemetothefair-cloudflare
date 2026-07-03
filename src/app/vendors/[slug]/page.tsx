import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
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
  eventSeries,
} from "@/lib/db/schema";
import { formatOccurrenceDate } from "@/lib/k18-vendor-grouping";
import { groupVendorShows } from "@/lib/series/group-vendor-shows";
import { VendorShowsByYear } from "@/components/vendors/VendorShowsByYear";
import { eq, ne, and, or, asc, desc, sql, isNull, inArray, gte } from "drizzle-orm";
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
import {
  canonicalParentSlugFor,
  displayVendorName,
  type DisplayableParent,
  type ParentDisplayInput,
  type VendorDisplayInput,
} from "@takemetothefair/utils";
import { cdnImage, focalPointGravity, OG_EVENT, OG_SQUARE } from "@/lib/cdn-image";

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

/**
 * EH2.1 — render-side glue between getVendor()'s return shape and the
 * displayVendorName helper. Hoisted so both generateMetadata and the page
 * render call the same code path (the alternative — two inlined input-
 * builder blobs — drifts the moment one is edited and the other isn't).
 */
type VendorWithHierarchy = Awaited<ReturnType<typeof getVendor>>;
function resolveDisplayName(vendor: NonNullable<VendorWithHierarchy>): string {
  const vendorInput: VendorDisplayInput = {
    role: vendor.role,
    brandParentVendorId: vendor.brandParentVendorId,
    operatorParentVendorId: vendor.operatorParentVendorId,
    aliasOfVendorId: vendor.aliasOfVendorId,
    displayOverridePermitted: vendor.displayOverridePermitted,
    displayMode: vendor.displayMode,
    businessName: vendor.businessName,
    displayName: vendor.displayName,
  };
  const brandParentInput: ParentDisplayInput | null = vendor.parent
    ? {
        id: vendor.parent.id,
        role: vendor.parent.role,
        defaultChildDisplay: vendor.parent.defaultChildDisplay,
        businessName: vendor.parent.businessName,
        displayName: vendor.parent.displayName,
      }
    : null;
  const operatorParentInput: ParentDisplayInput | null = vendor.operatorParent
    ? {
        id: vendor.operatorParent.id,
        role: vendor.operatorParent.role,
        defaultChildDisplay: vendor.operatorParent.defaultChildDisplay,
        businessName: vendor.operatorParent.businessName,
        displayName: vendor.operatorParent.displayName,
      }
    : null;
  return displayVendorName(vendorInput, brandParentInput, operatorParentInput);
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
    // Narrow events projection (OPE-70, 2026-07-02): the bare `events: events`
    // whole-table ref was event_vendors(10) + events(71) = 81 columns of
    // whole-table refs, edging toward D1's 100-col result-row cap (the same
    // failure class as the P3a venues incident above). Downstream only reads
    // id/name/slug/description/startDate/endDate/seriesId off the event (audited
    // via grep of `event.<field>` in this file — venue is attached separately,
    // not an events column), so project exactly those seven.
    const eventVendorResults = await db
      .select({
        event_vendors: eventVendors,
        events: {
          id: events.id,
          name: events.name,
          slug: events.slug,
          description: events.description,
          startDate: events.startDate,
          endDate: events.endDate,
          seriesId: events.seriesId,
        },
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

    // EH3 P2.5b — "Shows by year": group the vendor's events into the recurring
    // series they return to. The events row already carries series_id; the series
    // slug/name come from a SEPARATE small query (in-array on distinct ids) so the
    // main vendor-events projection stays under D1's 100-col result cap. We only
    // surface series with 2+ years — a "shows you return to" highlight, not a
    // restatement of the chronological lists below (which keep every event).
    const vendorSeriesIds = [
      ...new Set(vendorEvents.map((ve) => ve.event.seriesId).filter((x): x is string => !!x)),
    ];
    const seriesRefById = new Map<string, { canonicalSlug: string; name: string }>();
    if (vendorSeriesIds.length > 0) {
      const seriesRows = await db
        .select({
          id: eventSeries.id,
          canonicalSlug: eventSeries.canonicalSlug,
          name: eventSeries.name,
        })
        .from(eventSeries)
        .where(inArray(eventSeries.id, vendorSeriesIds));
      for (const s of seriesRows)
        seriesRefById.set(s.id, { canonicalSlug: s.canonicalSlug, name: s.name });
    }
    const seriesShows = groupVendorShows(
      vendorEvents.map((ve) => {
        const ref = ve.event.seriesId ? seriesRefById.get(ve.event.seriesId) : undefined;
        return {
          seriesId: ve.event.seriesId ?? null,
          seriesSlug: ref?.canonicalSlug ?? null,
          seriesName: ref?.name ?? null,
          eventSlug: ve.event.slug,
          eventName: ve.event.name,
          startDate: ve.event.startDate ?? null,
        };
      })
    ).series.filter((s) => s.years.length > 1);

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
      // EH2.1 — surface the brand's display_name override so the "Part of
      // <brand>" line + breadcrumb + JSON-LD parentOrganization all see the
      // brand's preferred marketing name (e.g. "LeafFilter" not "LeafFilter
      // North LLC"). Helper falls back to businessName when null.
      displayName: string | null;
    };
    let brandParent: ParentRow | null = null;
    let operatorParent: ParentRow | null = null;
    let children: Array<{
      id: string;
      slug: string;
      businessName: string;
      displayName: string | null;
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
          displayName: vendors.displayName,
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
          displayName: vendors.displayName,
        })
        .from(vendors)
        .where(
          and(eq(vendors.id, vendor.vendors.operatorParentVendorId), isNull(vendors.deletedAt))
        )
        .limit(1);
      if (opRow) operatorParent = opRow;
    }
    // EH2.3 — brand hub page extras. When this vendor is a NATIONAL brand,
    // fetch its LOCAL_OFFICE children + all upcoming events linked to those
    // offices so the hub page can render the "Upcoming Events" section
    // (union across all offices, dedup by event id). National brands
    // typically have no direct event_vendors of their own, so this is
    // where the brand-hub activity surface comes from.
    type AggregatedEvent = {
      id: string;
      name: string;
      slug: string;
      startDate: Date | null;
      endDate: Date | null;
      imageUrl: string | null;
      venueName: string | null;
      venueCity: string | null;
      venueState: string | null;
    };
    const aggregatedChildEvents: AggregatedEvent[] = [];
    if (vendor.vendors.role === "NATIONAL") {
      // EH2.3 follow-up (2026-06-10) — include offices linked via EITHER
      // brand_parent_vendor_id OR operator_parent_vendor_id. The original
      // EH2.3 query only matched brand parents, which left operator-parent
      // hubs (Shape C — Esler Companies operating RbA franchises) with an
      // empty "Local Offices" section even though the operator_parent FK
      // is set on the franchise rows. The OR dedups naturally: a Shape A
      // brand (LeafFilter) where brand_parent == operator_parent matches
      // the same children once. A Shape C operator-only hub (Esler) gets
      // its franchises via operator_parent. A pure brand parent
      // (Renewal by Andersen) keeps matching its franchises via brand_parent.
      children = await db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          businessName: vendors.businessName,
          displayName: vendors.displayName,
          city: vendors.city,
          state: vendors.state,
          contactPhone: vendors.contactPhone,
          contactEmail: vendors.contactEmail,
          vendorType: vendors.vendorType,
          logoUrl: vendors.logoUrl,
        })
        .from(vendors)
        .where(
          and(
            or(
              eq(vendors.brandParentVendorId, vendor.vendors.id),
              eq(vendors.operatorParentVendorId, vendor.vendors.id)
            ),
            isNull(vendors.deletedAt)
          )
        )
        .orderBy(asc(vendors.state), asc(vendors.city), asc(vendors.businessName));

      // Aggregated upcoming events across all children. Dedup by event_id
      // (rare but possible — same event with two offices both linked as
      // exhibitors). Public-status gate matches the office-page event
      // section so the hub doesn't surface anything the office page
      // would suppress.
      if (children.length > 0) {
        const childIds = children.map((c) => c.id);
        const childEventRows = await db
          .select({
            id: events.id,
            name: events.name,
            slug: events.slug,
            startDate: events.startDate,
            endDate: events.endDate,
            imageUrl: events.imageUrl,
            venueName: venues.name,
            venueCity: venues.city,
            venueState: venues.state,
          })
          .from(eventVendors)
          .innerJoin(events, eq(eventVendors.eventId, events.id))
          .leftJoin(venues, eq(events.venueId, venues.id))
          .where(
            and(
              inArray(eventVendors.vendorId, childIds),
              isPublicVendorStatus(),
              gte(events.endDate, new Date())
            )
          )
          .orderBy(asc(events.startDate));
        const seenIds = new Set<string>();
        for (const e of childEventRows) {
          if (seenIds.has(e.id)) continue;
          seenIds.add(e.id);
          aggregatedChildEvents.push(e);
        }
      }
    }

    return {
      ...vendor.vendors,
      user: vendor.users
        ? { name: vendor.users.name, email: vendor.users.email }
        : { name: null, email: null },
      eventVendors: vendorEvents,
      seriesShows,
      seoEventAssociationCount: Number(seoCounts?.eventAssociationCount ?? 0),
      seoEventVenueGeoCount: Number(seoCounts?.eventVenueGeoCount ?? 0),
      parent: brandParent,
      operatorParent,
      children,
      /* EH2.3 — upcoming events aggregated across the brand's offices.
         Empty array for non-NATIONAL rows. */
      aggregatedChildEvents,
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
        // EH2.1 — surface brand display_name override on the similar-vendors
        // module so the brand name (e.g. "LeafFilter") shows instead of
        // the legal-entity name (e.g. "LeafFilter North LLC").
        displayName: vendors.displayName,
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

  // EH2.1 — resolve the brand-aware display name. For INDEPENDENT vendors
  // (the common case) this is identical to vendor.businessName, so meta
  // tags / canonical / cache keys stay stable. For LOCAL_OFFICE rows under
  // a brand_parent-mode brand, the brand's name surfaces here too so the
  // page title + OG + Twitter all match what the user sees in the H1.
  const resolvedDisplayName = resolveDisplayName(vendor);
  const businessName = decodeHtmlEntities(resolvedDisplayName);
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
  // EH2.4 §B3 — self-mode NATIONAL hubs (RbA shape) emit noindex,follow.
  // The franchise pages (LOCAL_OFFICE children) get the search surface;
  // the brand hub exists for direct-link discovery (admin paths, claim
  // flows) but doesn't compete with the franchise pages in Google.
  // brand_parent-mode hubs stay indexable (they ARE the search surface).
  // NULL defaultChildDisplay falls through to noindex too — the brand
  // hasn't picked a policy, so the safer default is "don't compete."
  const isSelfModeBrandHub =
    vendor.role === "NATIONAL" &&
    (vendor.defaultChildDisplay === "self" || vendor.defaultChildDisplay == null);
  // Canonical-up implies noindex on the office page (parent owns the search
  // surface). Falls through to the §6.6 indexable predicate otherwise.
  const robotsValue =
    canonicalUpSlug || isSelfModeBrandHub
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
  // brand_parent mode = the brand is the SOLE public face; its regional
  // offices are collapsed everywhere (listing, search, and here). Suppress
  // the "Local Offices" grid + office-count wording so the hub presents the
  // national brand only. self/both/operator hubs (RbA, Esler, Goodhue…)
  // still enumerate their children, which ARE the public surfaces.
  const hidesOffices = isNationalHub && vendor.defaultChildDisplay === "brand_parent";
  const showsOfficeList = isNationalHub && !hidesOffices && vendor.children.length > 0;

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

  // EH2.1 — resolved display name for every surface EXCEPT the analytics
  // tracker. The DetailPageTracker `name` is a GA4 dimension that should
  // stay stable across an office's lifecycle so saved reports don't
  // fragment when a brand later opts into brand-parent collapse. Render
  // surfaces (H1, JSON-LD, breadcrumb, OG/Twitter, gallery alt) move to
  // the resolved string.
  const resolvedName = resolveDisplayName(vendor);
  return (
    <>
      <DetailPageTracker type="vendor" slug={vendor.slug} name={vendor.businessName} />
      <ScrollDepthTracker pageType="vendor-detail" />
      <VendorSchema
        businessName={resolvedName}
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
        /* EH2.3 — JSON-LD parentOrganization for LOCAL_OFFICE rows, pointing
           at the brand hub. Pairs with the brand hub's subOrganization
           below so search engines see the brand → office relationship. */
        parentOrganization={
          vendor.parent
            ? {
                name: decodeHtmlEntities(vendor.parent.displayName ?? vendor.parent.businessName),
                url: `https://meetmeatthefair.com/vendors/${vendor.parent.slug}`,
              }
            : null
        }
        /* EH2.3 — JSON-LD subOrganization on the brand hub (NATIONAL row)
           listing each LOCAL_OFFICE child. */
        subOrganizations={
          isNationalHub && vendor.children.length > 0
            ? vendor.children.map((child) => ({
                name: decodeHtmlEntities(child.displayName ?? child.businessName),
                url: `https://meetmeatthefair.com/vendors/${child.slug}`,
              }))
            : undefined
        }
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Vendors", url: "https://meetmeatthefair.com/vendors" },
          { name: resolvedName, url: `https://meetmeatthefair.com/vendors/${vendor.slug}` },
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
              {/* U10 (2026-06-21) — render the uploaded logo for EVERY tier.
                  Previously the whole tile was gated behind `isEnhanced`, so a
                  free vendor that had uploaded a logo (e.g. Two Apple Farm's
                  booth photo, stored in logo_url) showed only the monogram and
                  rendered zero <img> on the page — even though the og:image meta
                  already referenced the cdn-cgi URL. Now: logo present → image
                  for all tiers; no logo → monogram placeholder (UX-A2 Part A,
                  2026-06-08 — a hash-stable initials tile, not the old generic
                  Store icon that read as a broken image and fed the
                  "page looks abandoned" pattern behind the 1-of-2533 claim rate).
                  Served through cdnImage (fit=cover + focal point + format=auto)
                  to match the card and the global image rules. */}
              {vendor.logoUrl ? (
                (() => {
                  const gravity = focalPointGravity(vendor.imageFocalX, vendor.imageFocalY);
                  const opts = (w: number) => ({
                    width: w,
                    height: w,
                    fit: "cover" as const,
                    ...(gravity ? { gravity } : {}),
                    format: "auto" as const,
                    quality: 80,
                    onerror: "redirect" as const,
                  });
                  // 200px display slot; 1x/2x DPR variants.
                  const srcSet = [200, 400]
                    .map((w) => `${cdnImage(vendor.logoUrl!, opts(w))} ${w}w`)
                    .join(", ");
                  return (
                    <div
                      className="w-[200px] h-[200px] rounded-xl flex-shrink-0 relative overflow-hidden"
                      data-testid="vendor-logo"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={cdnImage(vendor.logoUrl, opts(200))}
                        srcSet={srcSet}
                        sizes="200px"
                        alt={`${resolvedName} logo`}
                        width={200}
                        height={200}
                        decoding="async"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    </div>
                  );
                })()
              ) : isEnhanced ? (
                // VendorMonogramLogo intentionally reads the raw businessName:
                // the initial-letter logo represents row identity, not the
                // resolved brand surface.
                <div
                  className="w-[200px] h-[200px] rounded-xl flex-shrink-0"
                  data-testid="vendor-logo-enhanced"
                >
                  <VendorMonogramLogo businessName={vendor.businessName} size={200} />
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
                      {decodeHtmlEntities(vendor.parent.displayName ?? vendor.parent.businessName)}
                    </Link>
                    {vendor.operatorParent && (
                      <>
                        {" "}
                        · operated by{" "}
                        <Link
                          href={`/vendors/${vendor.operatorParent.slug}`}
                          className="text-royal hover:text-navy font-medium underline"
                        >
                          {decodeHtmlEntities(
                            vendor.operatorParent.displayName ?? vendor.operatorParent.businessName
                          )}
                        </Link>
                      </>
                    )}
                  </p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-3xl font-bold text-foreground">{resolvedName}</h1>
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
                {/* EH2.3 — aggregated activity count on the brand hub.
                    "Exhibits at N show{s}" per spec §C3. Only renders for
                    NATIONAL rows with at least one aggregated upcoming
                    event across their offices. */}
                {isNationalHub && vendor.aggregatedChildEvents.length > 0 && (
                  <p className="mt-2 text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-4 h-4" />
                    Exhibits at {vendor.aggregatedChildEvents.length} upcoming{" "}
                    {vendor.aggregatedChildEvents.length === 1 ? "show" : "shows"}
                    {/* brand_parent hubs hide the office breakdown; only
                        self/operator hubs reveal "across N offices". */}
                    {!hidesOffices && (
                      <>
                        {" "}
                        across {vendor.children.length}{" "}
                        {vendor.children.length === 1 ? "office" : "offices"}
                      </>
                    )}
                  </p>
                )}
                {isEnhanced && (
                  <div className="mt-3">
                    <VendorContactForm vendorSlug={vendor.slug} vendorName={resolvedName} />
                  </div>
                )}
              </div>
            </div>

            {/* UX-A2a (2026-06-25) — surface the claim CTA above-the-fold, at
                the top of the main column. The sidebar stacks BELOW all content
                on mobile, so the claim funnel never fired for the exact audience
                that matters: a vendor seeing their own (unclaimed) page for the
                first time, by definition logged-out. Same gate + click-through
                as the sidebar instance (which this replaces). */}
            {!vendor.claimed && !isOwner && !isAdmin && (
              <ClaimListingCTA
                businessName={vendor.businessName}
                vendorSlug={vendor.slug}
                vendorId={vendor.id}
                eligibleForDirectClaim={eligibleForDirectClaim}
              />
            )}

            {isEnhanced && galleryImages.length > 0 && (
              <VendorGallery images={galleryImages} vendorName={resolvedName} />
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
                so swapping the section avoids a sad-empty Events block.
                Suppressed entirely for brand_parent-mode hubs (showsOfficeList)
                so the public sees the brand only, not its regional offices. */}
            {showsOfficeList && (
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
                            {/* Office card under the NATIONAL hub — show the
                                OFFICE's own self-name (with display_name
                                override) so the admin / public can identify
                                each office. Even under brand_parent-mode
                                collapse on /vendors listing, this section
                                exists specifically to enumerate offices. */}
                            {decodeHtmlEntities(child.displayName ?? child.businessName)}
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
                          {/* EH2.3 — email surfaced on the brand-hub office
                              card per spec §C3 "contact (incl. claimed
                              offices' email/phone when set)". */}
                          {child.contactEmail && (
                            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                              <Mail className="w-3 h-3" />
                              {child.contactEmail}
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
                state instead of leaving the main column visually bare.
                Not shown for brand_parent hubs: they intentionally never
                surface offices, so "No local offices listed yet" would be
                both wrong-headed and a structure leak. */}
            {isNationalHub && !hidesOffices && vendor.children.length === 0 && (
              <div className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">
                No local offices listed yet.
              </div>
            )}

            {/* EH2.3 — aggregated upcoming events across the brand's offices.
                Renders only on the NATIONAL hub. Each event card links to
                the event detail (not to the office that's exhibiting),
                matching the "the brand is at N shows" framing. Union is
                deduped by event_id at the data layer. */}
            {isNationalHub && vendor.aggregatedChildEvents.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-foreground">
                    Upcoming Events ({vendor.aggregatedChildEvents.length})
                  </h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {vendor.aggregatedChildEvents.slice(0, 12).map((ev) => (
                    <Link key={ev.id} href={`/events/${ev.slug}`} className="block">
                      <Card className="hover:shadow-md transition-shadow h-full">
                        <CardContent className="p-4">
                          <h3 className="font-medium text-foreground hover:text-navy">
                            {decodeHtmlEntities(ev.name)}
                          </h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            {formatDateRange(ev.startDate, ev.endDate)}
                          </p>
                          {ev.venueName && (
                            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />
                              {ev.venueName}
                              {ev.venueCity && ev.venueState
                                ? ` · ${ev.venueCity}, ${ev.venueState}`
                                : ""}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* EH3 P2.5b — recurring shows highlight (only when the vendor has a
                2+-year series). Sits above the chronological lists. */}
            {!isNationalHub && vendor.seriesShows.length > 0 && (
              <VendorShowsByYear series={vendor.seriesShows} />
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
                  {similarVendors.map((sv) => {
                    const svName = sv.displayName ?? sv.businessName;
                    return (
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
                              alt={`${svName} logo`}
                              width={56}
                              height={56}
                              loading="lazy"
                              decoding="async"
                              className="w-14 h-14 rounded-lg object-cover"
                            />
                          ) : (
                            // Monogram still uses raw businessName — row identity.
                            <VendorMonogramLogo
                              businessName={sv.businessName}
                              size={56}
                              className="!rounded-lg"
                            />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-foreground truncate">{svName}</p>
                          <p className="text-sm text-muted-foreground truncate">
                            {sv.vendorType}
                            {sv.city && sv.state && ` · ${sv.city}, ${sv.state}`}
                          </p>
                        </div>
                      </Link>
                    );
                  })}
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

            {/* UX-A2a — the claim CTA moved above-the-fold into the main column
                (see the header region). Intentionally not duplicated here. */}

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

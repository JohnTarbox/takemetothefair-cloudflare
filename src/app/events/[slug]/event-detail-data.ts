/**
 * Event-detail data + metadata core, extracted from `page.tsx` (K46, 2026-06-26).
 *
 * Lives in a sibling module — NOT `page.tsx` — because Next.js forbids extra
 * named exports on a route's `page` file (only `default`, `generateMetadata`,
 * and the route-config exports are allowed). The `/events/<series>/<year>`
 * occurrence route needs to share `buildEventMetadata` (and the `getEvent`
 * loader it depends on) to render the occurrence's own Event-detail metadata
 * with `asOccurrence`, instead of falling back to the series-landing metadata.
 * The page body (`EventDetailPage`) imports `getEvent` from here unchanged.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { SITE_URL } from "@takemetothefair/constants";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  events,
  venues,
  promoters,
  eventVendors,
  vendors,
  users,
  eventDays,
  eventSeries,
} from "@/lib/db/schema";
import { unsafeSlug } from "@/lib/utils";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { isPublicEventStatus } from "@/lib/event-status";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { resolveEventVendorTarget } from "@/lib/event-vendor-display";
import { logError } from "@/lib/logger";
import { buildEventTitle, buildEventMetaDescription } from "@/lib/seo-utils";
import { cdnImage, OG_EVENT } from "@/lib/cdn-image";
import { getSeriesLanding } from "@/lib/series/get-series-landing";

export async function getEvent(slug: string) {
  const db = getCloudflareDb();

  try {
    // Get event with venue and promoter. Narrow projection — D1's 100-col
    // result-row cap; see eventJoinProjection for the audit + contract.
    const eventResults = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(and(eq(events.slug, unsafeSlug(slug)), isPublicEventStatus()))
      .limit(1);

    if (eventResults.length === 0) return null;

    const eventData = eventResults[0];

    // Get promoter's user
    const promoterUser = eventData.promoter?.userId
      ? await db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, eventData.promoter.userId))
          .limit(1)
      : [];

    // Get event vendors. Soft-deleted vendors (drizzle/0053) are filtered
    // out — the entry hides entirely from the event's vendor lineup per the
    // delete_vendor UX contract.
    // Sorted alphabetically (case-insensitive via COLLATE NOCASE) by
    // businessName so the public lineup is stable across page loads and
    // mixed-case names sort naturally — pre-fix it was rowid/insertion
    // order (PR #161), then BINARY-collation alphabetical (PR #162, which
    // landed "AccuTech" after all all-uppercase names).
    const eventVendorResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(vendors, eq(eventVendors.vendorId, vendors.id))
      .where(
        and(
          eq(eventVendors.eventId, eventData.events.id),
          isPublicVendorStatus(),
          isNull(vendors.deletedAt)
        )
      )
      .orderBy(sql`${vendors.businessName} COLLATE NOCASE`);

    // EH2 brand_parent collapse — load brand/operator parents for any
    // LOCAL_OFFICE participants so the lineup can show the brand (LeafFilter)
    // instead of the regional office. Single batched read; skipped entirely
    // when no office vendors are present (the common case).
    const vendorParentIds = Array.from(
      new Set(
        eventVendorResults
          .filter((ev) => ev.vendors?.role === "LOCAL_OFFICE")
          .flatMap((ev) => [ev.vendors!.brandParentVendorId, ev.vendors!.operatorParentVendorId])
          .filter((v): v is string => v != null)
      )
    );
    const parentRows =
      vendorParentIds.length > 0
        ? await db
            .select({
              id: vendors.id,
              slug: vendors.slug,
              role: vendors.role,
              businessName: vendors.businessName,
              displayName: vendors.displayName,
              defaultChildDisplay: vendors.defaultChildDisplay,
            })
            .from(vendors)
            .where(inArray(vendors.id, vendorParentIds))
        : [];
    const parentById = new Map(parentRows.map((p) => [p.id, p]));

    // Get event days (per-day schedule)
    const eventDayResults = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, eventData.events.id))
      .orderBy(eventDays.date);

    // Increment view count
    await db
      .update(events)
      .set({ viewCount: sql`${events.viewCount} + 1` })
      .where(eq(events.id, eventData.events.id));

    // venue/promoter are the lite projection from eventJoinProjection;
    // cast back to the schema row type so consumer prop types compile
    // unchanged. Sound because every venue/promoter field consumers
    // actually read is present in the projection (audit 2026-06-04).
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;

    // EH3 P2.3b — if this event is an occurrence of a series, resolve the parent
    // series ref (canonical_slug + name) for the occurrence canonical URL +
    // schema.org superEvent. seriesId is NULL for every event until the P1
    // backfill, so this extra lookup never runs today.
    let series: { canonicalSlug: string; name: string } | null = null;
    if (eventData.events.seriesId) {
      const [s] = await db
        .select({ canonicalSlug: eventSeries.canonicalSlug, name: eventSeries.name })
        .from(eventSeries)
        .where(eq(eventSeries.id, eventData.events.seriesId))
        .limit(1);
      series = s ?? null;
    }

    return {
      ...eventData.events,
      series,
      venue: eventData.venue as FullVenue | null,
      promoter: eventData.promoter
        ? {
            ...(eventData.promoter as FullPromoter),
            user: promoterUser[0] || { name: null, email: null },
          }
        : null,
      eventVendors: eventVendorResults.map((ev) => {
        const vendor = ev.vendors!;
        // EH2 — resolved public-facing {name, slug}. For brand_parent /
        // operator offices this is the brand name + hub slug; otherwise the
        // vendor's own self-name + slug. Used by every public render surface
        // (lineup cards, JSON-LD performer, "all vendors" sub-page).
        const displayTarget = resolveEventVendorTarget(
          vendor,
          parentById.get(vendor.brandParentVendorId ?? "") ?? null,
          parentById.get(vendor.operatorParentVendorId ?? "") ?? null
        );
        return {
          ...ev.event_vendors,
          vendor,
          displayTarget,
        };
      }),
      eventDays: eventDayResults,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching event",
      error: e,
      source: "app/events/[slug]/page.tsx:getEvent",
      context: { slug },
    });
    // REL1' §1 (2026-06-04): throw FetchError on query failure so
    // Next.js routes to error.tsx (service-unavailable), NOT notFound()
    // which would emit 404 and tell crawlers the page no longer exists.
    // Returning null here would force the caller into notFound(),
    // confusing transient outage with permanent delete. Genuine
    // empty-row case is handled inline above (`return null` on length=0).
    const { FetchError } = await import("@/lib/errors/fetch-error");
    throw new FetchError("app/events/[slug]/page.tsx:getEvent", e);
  }
}

/**
 * Core metadata builder — shared by the bare `/events/[slug]` page export
 * (below) and the `/events/<series>/<year>` occurrence route. Kept separate
 * from the Next.js `generateMetadata` export because Next forbids extra fields
 * on the page-props type AND injects a `parent` ResolvingMetadata as the 2nd
 * positional arg, so the `asOccurrence` flag can ride on neither. (K46)
 */
export async function buildEventMetadata(slug: string, asOccurrence = false): Promise<Metadata> {
  // EH3 P2.3 — series-first resolution. When the slug is a series canonical_slug,
  // render the series-landing metadata (self-canonical to /events/<series>).
  // Returns null until the gated backfill creates series, so event pages are
  // unaffected today.
  // K46 — the /year occurrence route passes asOccurrence so the occurrence
  // canonicalizes to /events/<series>/<year> instead of the landing URL.
  const landing = asOccurrence ? null : await getSeriesLanding(slug);
  if (landing) {
    const url = `${SITE_URL}/events/${landing.series.canonicalSlug}`;
    const title = `${landing.series.name} — Meet Me at the Fair`;
    const description =
      landing.series.description ??
      `${landing.series.name}: every year's dates, location, and details.`;
    // Emit og:image/twitter for the landing too — mirrors the occurrence block.
    // The series row's imageUrl is commonly NULL (backfill seeds defaults from an
    // image-less member), so fall back to og-default; route through cdn-cgi/image
    // for the 1200×630 gravity=auto derivative, exactly like the occurrence page.
    const ogImage = cdnImage(
      landing.series.imageUrl || "https://meetmeatthefair.com/og-default.png",
      OG_EVENT
    );
    return {
      title,
      description,
      alternates: { canonical: url },
      openGraph: {
        title,
        description,
        url,
        siteName: "Meet Me at the Fair",
        type: "website",
        images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
      },
      twitter: { card: "summary_large_image", title, description, images: [ogImage] },
    };
  }

  const event = await getEvent(slug);

  if (!event) {
    // MIG4 — notFound() here renders the canonical global 404 page
    // (`app/not-found.tsx`) with Next's framework-injected `<meta robots
    // noindex>`, which is what keeps bogus slugs out of the index.
    //
    // KNOWN LIMITATION: these routes are ISR (`revalidate = 300`), and under
    // @opennextjs/cloudflare a notFound() on an ISR route is served as a
    // cacheable HTTP *200* — the 404 *status* does NOT propagate (same class
    // as the K2 streaming-status wall). So it's a soft-404 by status, hard by
    // noindex. Accepted: the noindex prevents indexing; a true 404 status would
    // cost ISR caching or a proxy-worker rewrite. See
    // docs/mig4-soft-404-opennext-isr.md. getEvent is React-cached (no extra D1
    // read); the page-body notFound() remains as defense-in-depth.
    notFound();
  }

  const title = buildEventTitle(event);
  const description = buildEventMetaDescription(event);
  // EH3 P2.3b — an occurrence of a series canonicalizes to its Option-A year URL
  // (/events/<series>/<year>), regardless of which URL served it, so the legacy
  // event slug never competes as a duplicate. Standalone events (every event
  // until backfill) keep their own self-canonical.
  const occYear =
    event.series && event.startDate ? new Date(event.startDate).getUTCFullYear() : null;
  const url =
    event.series && occYear
      ? `${SITE_URL}/events/${event.series.canonicalSlug}/${occYear}`
      : `https://meetmeatthefair.com/events/${event.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      siteName: "Meet Me at the Fair",
      // `og:type` set via `other` below. OG protocol supports "event" but
      // Next.js's openGraph.type union doesn't. Tried `type: "event" as never`
      // (PR #135, 2026-05-11) to emit canonical `property=` — but Next.js's
      // openGraph serializer throws on the unknown discriminant and silently
      // skips ALL metadata generation, breaking every page. Reverted same day
      // (PR #136). `other` emits `name="og:type"` which is non-canonical:
      // Google honors both attribute forms, but Facebook's Sharing Debugger
      // only honors `property=` and flags `name=` as a warning (confirmed by
      // audit 2026-05-11). Accepted trade-off: cosmetic FB warning vs. risk
      // of re-breaking site-wide metadata. See
      // feedback_nextjs_metadata_type_cast_runtime.md.
      images: [
        {
          // Static OG fallback — `/api/og` dynamic generator removed
          // 2026-06-04 to keep the main-app Worker under the 25 MiB
          // Cloudflare bundle cap (satori + resvg-wasm was ~476 KiB
          // compiled). 81% of events have no per-event image so this
          // was the common case; matches every other index page.
          //
          // IMG1 (2026-06-07) — both real images and the og-default are
          // now routed through `cdn-cgi/image` so social previews get
          // exactly the 1200×630 derivative with `gravity=auto` smart
          // crop (saves the 1942×809 panorama case where the old raw
          // URL forced platforms to letterbox/zoom).
          url: cdnImage(event.imageUrl || "https://meetmeatthefair.com/og-default.png", OG_EVENT),
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [cdnImage(event.imageUrl || "https://meetmeatthefair.com/og-default.png", OG_EVENT)],
    },
    other: {
      "og:type": "event",
    },
  };
}

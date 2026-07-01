/**
 * Shared vendor-events data loader (OPE-40). Used by BOTH the server-rendered
 * /vendors/[slug]/events page and the /api/vendors/[slug]/events route, so the
 * page can SSR its event links (crawlable) instead of client-fetching them.
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { vendors, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { isPublicEventStatus } from "@/lib/event-status";
import { unsafeSlug } from "@/lib/utils";

type Db = DrizzleD1Database<typeof schema>;

export interface VendorEventItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  /** ISO-8601 string (or "" if unset) — matches the previous API JSON shape. */
  startDate: string;
  endDate: string;
  imageUrl: string | null;
  categories: string[];
  venue: {
    name: string;
    city: string;
    state: string;
    address: string | null;
    zip: string | null;
    timezone: string;
  };
}

export interface VendorEventsData {
  vendor: { id: string; businessName: string; displayName: string | null; slug: string };
  events: VendorEventItem[];
}

function parseCategories(categories: unknown): string[] {
  if (!categories) return [];
  if (Array.isArray(categories)) return categories as string[];
  if (typeof categories === "string") {
    try {
      const parsed = JSON.parse(categories);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const iso = (d: Date | string | null | undefined): string =>
  d instanceof Date ? d.toISOString() : typeof d === "string" ? d : "";

/** Returns the vendor + its public events, or null if the vendor doesn't exist. */
export async function getVendorEventsData(db: Db, slug: string): Promise<VendorEventsData | null> {
  const vendorResults = await db
    .select({
      id: vendors.id,
      businessName: vendors.businessName,
      displayName: vendors.displayName,
      slug: vendors.slug,
    })
    .from(vendors)
    .where(eq(vendors.slug, unsafeSlug(slug)))
    .limit(1);

  if (vendorResults.length === 0) return null;
  const vendor = vendorResults[0];

  const eventResults = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      description: events.description,
      startDate: events.startDate,
      endDate: events.endDate,
      imageUrl: events.imageUrl,
      categories: events.categories,
      venueName: venues.name,
      venueCity: venues.city,
      venueState: venues.state,
      venueAddress: venues.address,
      venueZip: venues.zip,
      venueTimezone: venues.timezone,
    })
    .from(eventVendors)
    .leftJoin(events, eq(eventVendors.eventId, events.id))
    .leftJoin(venues, eq(events.venueId, venues.id))
    .where(and(eq(eventVendors.vendorId, vendor.id), isPublicVendorStatus(), isPublicEventStatus()))
    .orderBy(asc(events.startDate));

  const formattedEvents: VendorEventItem[] = eventResults
    .filter((e) => e.id !== null)
    .map((e) => ({
      id: e.id as string,
      name: e.name ?? "",
      slug: e.slug ?? "",
      description: e.description ?? null,
      startDate: iso(e.startDate),
      endDate: iso(e.endDate),
      imageUrl: e.imageUrl ?? null,
      categories: parseCategories(e.categories),
      venue: {
        name: e.venueName || "Unknown Venue",
        city: e.venueCity || "",
        state: e.venueState || "",
        address: e.venueAddress ?? null,
        zip: e.venueZip ?? null,
        timezone: e.venueTimezone || "America/New_York",
      },
    }));

  return {
    vendor: {
      id: vendor.id,
      businessName: vendor.businessName,
      displayName: vendor.displayName,
      slug: vendor.slug,
    },
    events: formattedEvents,
  };
}

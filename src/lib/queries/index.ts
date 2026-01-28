/**
 * Reusable query helpers to eliminate N+1 queries and reduce code duplication
 */

import { eq, count, and, gte } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  venues,
  events,
  vendors,
  promoters,
  eventVendors,
  users,
  userFavorites,
} from "@/lib/db/schema";

// Types for query results
export type VenueWithCount = typeof venues.$inferSelect & {
  _count: { events: number };
};

export type VendorWithCount = typeof vendors.$inferSelect & {
  user: { email: string; name: string | null } | null;
  _count: { events: number };
};

export type PromoterWithCount = typeof promoters.$inferSelect & {
  user: { email: string; name: string | null } | null;
  _count: { events: number };
};

export type EventWithRelations = typeof events.$inferSelect & {
  venue: typeof venues.$inferSelect | null;
  promoter: typeof promoters.$inferSelect | null;
  _count: { eventVendors: number };
};

/**
 * Get all venues with event counts in a single query using subquery
 */
export async function getVenuesWithEventCounts(db: Database): Promise<VenueWithCount[]> {
  // Get all venues
  const venueList = await db.select().from(venues).orderBy(venues.name);

  if (venueList.length === 0) return [];

  // Get all event counts grouped by venue in a single query
  const eventCounts = await db
    .select({
      venueId: events.venueId,
      count: count(),
    })
    .from(events)
    .groupBy(events.venueId);

  // Create a map for O(1) lookup
  const countMap = new Map(eventCounts.map(ec => [ec.venueId, ec.count]));

  // Combine venues with their counts
  return venueList.map(venue => ({
    ...venue,
    _count: { events: countMap.get(venue.id) || 0 },
  }));
}

/**
 * Get all vendors with user info and event counts in minimal queries
 */
export async function getVendorsWithCounts(db: Database): Promise<VendorWithCount[]> {
  // Get vendors with user info in a single query
  const vendorList = await db
    .select({
      vendor: vendors,
      user: {
        email: users.email,
        name: users.name,
      },
    })
    .from(vendors)
    .leftJoin(users, eq(vendors.userId, users.id))
    .orderBy(vendors.businessName);

  if (vendorList.length === 0) return [];

  // Get all event counts grouped by vendor in a single query
  const eventCounts = await db
    .select({
      vendorId: eventVendors.vendorId,
      count: count(),
    })
    .from(eventVendors)
    .groupBy(eventVendors.vendorId);

  // Create a map for O(1) lookup
  const countMap = new Map(eventCounts.map(ec => [ec.vendorId, ec.count]));

  // Combine vendors with their counts
  return vendorList.map(v => ({
    ...v.vendor,
    user: v.user?.email ? { email: v.user.email, name: v.user.name } : null,
    _count: { events: countMap.get(v.vendor.id) || 0 },
  }));
}

/**
 * Get all promoters with user info and event counts in minimal queries
 */
export async function getPromotersWithCounts(db: Database): Promise<PromoterWithCount[]> {
  // Get promoters with user info in a single query
  const promoterList = await db
    .select({
      promoter: promoters,
      user: {
        email: users.email,
        name: users.name,
      },
    })
    .from(promoters)
    .leftJoin(users, eq(promoters.userId, users.id))
    .orderBy(promoters.companyName);

  if (promoterList.length === 0) return [];

  // Get all event counts grouped by promoter in a single query
  const eventCounts = await db
    .select({
      promoterId: events.promoterId,
      count: count(),
    })
    .from(events)
    .groupBy(events.promoterId);

  // Create a map for O(1) lookup
  const countMap = new Map(eventCounts.map(ec => [ec.promoterId, ec.count]));

  // Combine promoters with their counts
  return promoterList.map(p => ({
    ...p.promoter,
    user: p.user?.email ? { email: p.user.email, name: p.user.name } : null,
    _count: { events: countMap.get(p.promoter.id) || 0 },
  }));
}

/**
 * Get events with venue and promoter relations and vendor counts
 */
export async function getEventsWithRelations(
  db: Database,
  options: {
    status?: string;
    includeVendorCounts?: boolean;
    limit?: number;
    offset?: number;
    futureOnly?: boolean;
  } = {}
): Promise<EventWithRelations[]> {
  const { status, includeVendorCounts = true, limit, offset, futureOnly = false } = options;

  // Build conditions
  const conditions = [];
  if (status) {
    conditions.push(eq(events.status, status));
  }
  if (futureOnly) {
    conditions.push(gte(events.endDate, new Date()));
  }

  // Get events with venue and promoter in a single query
  let query = db
    .select({
      event: events,
      venue: venues,
      promoter: promoters,
    })
    .from(events)
    .leftJoin(venues, eq(events.venueId, venues.id))
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .orderBy(events.startDate);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  if (limit) {
    query = query.limit(limit) as typeof query;
  }

  if (offset) {
    query = query.offset(offset) as typeof query;
  }

  const eventList = await query;

  if (eventList.length === 0) return [];

  // Get vendor counts if needed
  let countMap = new Map<string, number>();
  if (includeVendorCounts) {
    const vendorCounts = await db
      .select({
        eventId: eventVendors.eventId,
        count: count(),
      })
      .from(eventVendors)
      .groupBy(eventVendors.eventId);

    countMap = new Map(vendorCounts.map(vc => [vc.eventId, vc.count]));
  }

  // Combine events with their relations and counts
  return eventList.map(e => ({
    ...e.event,
    venue: e.venue,
    promoter: e.promoter,
    _count: { eventVendors: countMap.get(e.event.id) || 0 },
  }));
}

/**
 * Get a single venue by ID with event count
 */
export async function getVenueById(db: Database, id: string): Promise<VenueWithCount | null> {
  const [venue] = await db.select().from(venues).where(eq(venues.id, id)).limit(1);

  if (!venue) return null;

  const [eventCount] = await db
    .select({ count: count() })
    .from(events)
    .where(eq(events.venueId, id));

  return {
    ...venue,
    _count: { events: eventCount?.count || 0 },
  };
}

/**
 * Get a single vendor by ID with user info and event count
 */
export async function getVendorById(db: Database, id: string): Promise<VendorWithCount | null> {
  const [result] = await db
    .select({
      vendor: vendors,
      user: {
        email: users.email,
        name: users.name,
      },
    })
    .from(vendors)
    .leftJoin(users, eq(vendors.userId, users.id))
    .where(eq(vendors.id, id))
    .limit(1);

  if (!result) return null;

  const [eventCount] = await db
    .select({ count: count() })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, id));

  return {
    ...result.vendor,
    user: result.user?.email ? { email: result.user.email, name: result.user.name } : null,
    _count: { events: eventCount?.count || 0 },
  };
}

/**
 * Get a single promoter by ID with user info and event count
 */
export async function getPromoterById(db: Database, id: string): Promise<PromoterWithCount | null> {
  const [result] = await db
    .select({
      promoter: promoters,
      user: {
        email: users.email,
        name: users.name,
      },
    })
    .from(promoters)
    .leftJoin(users, eq(promoters.userId, users.id))
    .where(eq(promoters.id, id))
    .limit(1);

  if (!result) return null;

  const [eventCount] = await db
    .select({ count: count() })
    .from(events)
    .where(eq(events.promoterId, id));

  return {
    ...result.promoter,
    user: result.user?.email ? { email: result.user.email, name: result.user.name } : null,
    _count: { events: eventCount?.count || 0 },
  };
}

/**
 * Count favorites for an entity
 */
export async function countFavorites(
  db: Database,
  favoritableType: string,
  favoritableId: string
): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(userFavorites)
    .where(
      and(
        eq(userFavorites.favoritableType, favoritableType),
        eq(userFavorites.favoritableId, favoritableId)
      )
    );

  return result?.count || 0;
}

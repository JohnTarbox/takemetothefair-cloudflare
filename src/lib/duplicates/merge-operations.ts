import { eq, and, inArray, sql, notInArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  venues,
  events,
  vendors,
  promoters,
  eventVendors,
  userFavorites
} from "@/lib/db/schema";
import type {
  DuplicateEntityType,
  MergePreviewResponse,
  MergeResponse,
  RelationshipCounts,
} from "./types";

/**
 * Get merge preview for two entities
 * Returns what will happen if they are merged
 */
export async function getMergePreview(
  db: Database,
  type: DuplicateEntityType,
  primaryId: string,
  duplicateId: string
): Promise<MergePreviewResponse> {
  switch (type) {
    case "venues":
      return getVenueMergePreview(db, primaryId, duplicateId);
    case "events":
      return getEventMergePreview(db, primaryId, duplicateId);
    case "vendors":
      return getVendorMergePreview(db, primaryId, duplicateId);
    case "promoters":
      return getPromoterMergePreview(db, primaryId, duplicateId);
    default:
      throw new Error(`Unknown entity type: ${type}`);
  }
}

/**
 * Execute merge operation
 */
export async function executeMerge(
  db: Database,
  type: DuplicateEntityType,
  primaryId: string,
  duplicateId: string
): Promise<MergeResponse> {
  switch (type) {
    case "venues":
      return mergeVenues(db, primaryId, duplicateId);
    case "events":
      return mergeEvents(db, primaryId, duplicateId);
    case "vendors":
      return mergeVendors(db, primaryId, duplicateId);
    case "promoters":
      return mergePromoters(db, primaryId, duplicateId);
    default:
      throw new Error(`Unknown entity type: ${type}`);
  }
}

// =============================================================================
// VENUE MERGE OPERATIONS
// =============================================================================

async function getVenueMergePreview(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergePreviewResponse> {
  const [primary] = await db.select().from(venues).where(eq(venues.id, primaryId));
  const [duplicate] = await db.select().from(venues).where(eq(venues.id, duplicateId));

  if (!primary || !duplicate) {
    throw new Error("One or both venues not found");
  }

  // Count events for each venue
  const [primaryEventCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.venueId, primaryId));

  const [duplicateEventCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.venueId, duplicateId));

  // Count favorites to transfer
  const [favoritesCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "VENUE"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  const relationshipsToTransfer: RelationshipCounts = {
    events: duplicateEventCount?.count || 0,
    favorites: favoritesCount?.count || 0,
  };

  return {
    primary: { ...primary, _count: { events: primaryEventCount?.count || 0 } },
    duplicate: { ...duplicate, _count: { events: duplicateEventCount?.count || 0 } },
    relationshipsToTransfer,
    warnings: [],
    canMerge: true,
  };
}

async function mergeVenues(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergeResponse> {
  const transferred: RelationshipCounts = { events: 0, favorites: 0 };

  // Transfer events from duplicate to primary
  const eventResult = await db
    .update(events)
    .set({ venueId: primaryId })
    .where(eq(events.venueId, duplicateId));
  transferred.events = eventResult.rowsAffected || 0;

  // Get existing favorites for primary venue
  const existingFavorites = await db
    .select({ userId: userFavorites.userId })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "VENUE"),
      eq(userFavorites.favoritableId, primaryId)
    ));
  const existingUserIds = existingFavorites.map(f => f.userId);

  // Transfer favorites that don't already exist
  if (existingUserIds.length > 0) {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "VENUE"),
        eq(userFavorites.favoritableId, duplicateId),
        notInArray(userFavorites.userId, existingUserIds)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  } else {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "VENUE"),
        eq(userFavorites.favoritableId, duplicateId)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  }

  // Delete remaining duplicate favorites
  await db
    .delete(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "VENUE"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  // Delete duplicate venue
  await db.delete(venues).where(eq(venues.id, duplicateId));

  const [mergedEntity] = await db.select().from(venues).where(eq(venues.id, primaryId));
  const [eventCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.venueId, primaryId));

  return {
    success: true,
    mergedEntity: { ...mergedEntity, _count: { events: eventCount?.count || 0 } },
    transferredRelationships: transferred,
    deletedId: duplicateId,
  };
}

// =============================================================================
// PROMOTER MERGE OPERATIONS
// =============================================================================

async function getPromoterMergePreview(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergePreviewResponse> {
  const [primary] = await db.select().from(promoters).where(eq(promoters.id, primaryId));
  const [duplicate] = await db.select().from(promoters).where(eq(promoters.id, duplicateId));

  if (!primary || !duplicate) {
    throw new Error("One or both promoters not found");
  }

  const warnings: string[] = [];
  const canMerge = true;

  if (primary.userId !== duplicate.userId) {
    warnings.push(
      "These promoters are linked to different user accounts. Merging will only transfer events and favorites, not the user account."
    );
  }

  const [duplicateEventCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.promoterId, duplicateId));

  const [primaryEventCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.promoterId, primaryId));

  const [favoritesCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "PROMOTER"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  const relationshipsToTransfer: RelationshipCounts = {
    events: duplicateEventCount?.count || 0,
    favorites: favoritesCount?.count || 0,
  };

  return {
    primary: { ...primary, _count: { events: primaryEventCount?.count || 0 } },
    duplicate: { ...duplicate, _count: { events: duplicateEventCount?.count || 0 } },
    relationshipsToTransfer,
    warnings,
    canMerge,
  };
}

async function mergePromoters(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergeResponse> {
  const transferred: RelationshipCounts = { events: 0, favorites: 0 };

  // Transfer events
  const eventResult = await db
    .update(events)
    .set({ promoterId: primaryId })
    .where(eq(events.promoterId, duplicateId));
  transferred.events = eventResult.rowsAffected || 0;

  // Get existing favorites
  const existingFavorites = await db
    .select({ userId: userFavorites.userId })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "PROMOTER"),
      eq(userFavorites.favoritableId, primaryId)
    ));
  const existingUserIds = existingFavorites.map(f => f.userId);

  // Transfer favorites
  if (existingUserIds.length > 0) {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "PROMOTER"),
        eq(userFavorites.favoritableId, duplicateId),
        notInArray(userFavorites.userId, existingUserIds)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  } else {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "PROMOTER"),
        eq(userFavorites.favoritableId, duplicateId)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  }

  // Delete remaining duplicate favorites
  await db
    .delete(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "PROMOTER"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  // Delete duplicate promoter
  await db.delete(promoters).where(eq(promoters.id, duplicateId));

  const [mergedEntity] = await db.select().from(promoters).where(eq(promoters.id, primaryId));
  const [eventCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.promoterId, primaryId));

  return {
    success: true,
    mergedEntity: { ...mergedEntity, _count: { events: eventCount?.count || 0 } },
    transferredRelationships: transferred,
    deletedId: duplicateId,
  };
}

// =============================================================================
// VENDOR MERGE OPERATIONS
// =============================================================================

async function getVendorMergePreview(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergePreviewResponse> {
  const [primary] = await db.select().from(vendors).where(eq(vendors.id, primaryId));
  const [duplicate] = await db.select().from(vendors).where(eq(vendors.id, duplicateId));

  if (!primary || !duplicate) {
    throw new Error("One or both vendors not found");
  }

  const warnings: string[] = [];
  const canMerge = true;

  if (primary.userId !== duplicate.userId) {
    warnings.push(
      "These vendors are linked to different user accounts. Merging will only transfer event participations and favorites, not the user account."
    );
  }

  const [duplicateEventVendorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, duplicateId));

  const [primaryEventVendorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, primaryId));

  const [favoritesCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "VENDOR"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  // Check for overlapping events
  const duplicateEventIds = await db
    .select({ eventId: eventVendors.eventId })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, duplicateId));

  const primaryEventIds = await db
    .select({ eventId: eventVendors.eventId })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, primaryId));

  const primaryEventSet = new Set(primaryEventIds.map(e => e.eventId));
  const overlappingEvents = duplicateEventIds.filter(e => primaryEventSet.has(e.eventId));

  if (overlappingEvents.length > 0) {
    warnings.push(
      `${overlappingEvents.length} event(s) have both vendors assigned. Duplicate assignments will be removed.`
    );
  }

  const relationshipsToTransfer: RelationshipCounts = {
    eventVendors: (duplicateEventVendorCount?.count || 0) - overlappingEvents.length,
    favorites: favoritesCount?.count || 0,
  };

  return {
    primary: { ...primary, _count: { eventVendors: primaryEventVendorCount?.count || 0 } },
    duplicate: { ...duplicate, _count: { eventVendors: duplicateEventVendorCount?.count || 0 } },
    relationshipsToTransfer,
    warnings,
    canMerge,
  };
}

async function mergeVendors(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergeResponse> {
  const transferred: RelationshipCounts = { eventVendors: 0, favorites: 0 };

  // Get events where primary vendor is already assigned
  const primaryEvents = await db
    .select({ eventId: eventVendors.eventId })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, primaryId));
  const primaryEventIds = primaryEvents.map(e => e.eventId);

  // Delete overlapping event_vendor records
  if (primaryEventIds.length > 0) {
    await db
      .delete(eventVendors)
      .where(and(
        eq(eventVendors.vendorId, duplicateId),
        inArray(eventVendors.eventId, primaryEventIds)
      ));
  }

  // Transfer remaining event_vendors
  const eventVendorResult = await db
    .update(eventVendors)
    .set({ vendorId: primaryId })
    .where(eq(eventVendors.vendorId, duplicateId));
  transferred.eventVendors = eventVendorResult.rowsAffected || 0;

  // Get existing favorites
  const existingFavorites = await db
    .select({ userId: userFavorites.userId })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "VENDOR"),
      eq(userFavorites.favoritableId, primaryId)
    ));
  const existingUserIds = existingFavorites.map(f => f.userId);

  // Transfer favorites
  if (existingUserIds.length > 0) {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "VENDOR"),
        eq(userFavorites.favoritableId, duplicateId),
        notInArray(userFavorites.userId, existingUserIds)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  } else {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "VENDOR"),
        eq(userFavorites.favoritableId, duplicateId)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  }

  // Delete remaining duplicate favorites
  await db
    .delete(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "VENDOR"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  // Delete duplicate vendor
  await db.delete(vendors).where(eq(vendors.id, duplicateId));

  const [mergedEntity] = await db.select().from(vendors).where(eq(vendors.id, primaryId));
  const [eventVendorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, primaryId));

  return {
    success: true,
    mergedEntity: { ...mergedEntity, _count: { eventVendors: eventVendorCount?.count || 0 } },
    transferredRelationships: transferred,
    deletedId: duplicateId,
  };
}

// =============================================================================
// EVENT MERGE OPERATIONS
// =============================================================================

async function getEventMergePreview(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergePreviewResponse> {
  const [primary] = await db
    .select()
    .from(events)
    .where(eq(events.id, primaryId));

  const [duplicate] = await db
    .select()
    .from(events)
    .where(eq(events.id, duplicateId));

  if (!primary || !duplicate) {
    throw new Error("One or both events not found");
  }

  // Get venue and promoter info
  const [primaryVenue] = await db.select({ name: venues.name }).from(venues).where(eq(venues.id, primary.venueId));
  const [duplicateVenue] = await db.select({ name: venues.name }).from(venues).where(eq(venues.id, duplicate.venueId));
  const [primaryPromoter] = await db.select({ companyName: promoters.companyName }).from(promoters).where(eq(promoters.id, primary.promoterId));
  const [duplicatePromoter] = await db.select({ companyName: promoters.companyName }).from(promoters).where(eq(promoters.id, duplicate.promoterId));

  const warnings: string[] = [];

  if (primary.promoterId !== duplicate.promoterId) {
    warnings.push(
      `Events have different promoters: "${primaryPromoter?.companyName}" vs "${duplicatePromoter?.companyName}"`
    );
  }

  if (primary.venueId !== duplicate.venueId) {
    warnings.push(
      `Events have different venues: "${primaryVenue?.name}" vs "${duplicateVenue?.name}"`
    );
  }

  const [duplicateEventVendorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, duplicateId));

  const [primaryEventVendorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, primaryId));

  const [favoritesCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "EVENT"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  // Check for overlapping vendors
  const duplicateVendorIds = await db
    .select({ vendorId: eventVendors.vendorId })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, duplicateId));

  const primaryVendorIds = await db
    .select({ vendorId: eventVendors.vendorId })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, primaryId));

  const primaryVendorSet = new Set(primaryVendorIds.map(v => v.vendorId));
  const overlappingVendors = duplicateVendorIds.filter(v => primaryVendorSet.has(v.vendorId));

  if (overlappingVendors.length > 0) {
    warnings.push(
      `${overlappingVendors.length} vendor(s) are assigned to both events. Duplicate assignments will be removed.`
    );
  }

  const relationshipsToTransfer: RelationshipCounts = {
    eventVendors: (duplicateEventVendorCount?.count || 0) - overlappingVendors.length,
    favorites: favoritesCount?.count || 0,
  };

  return {
    primary: {
      ...primary,
      venue: primaryVenue,
      promoter: primaryPromoter,
      _count: { eventVendors: primaryEventVendorCount?.count || 0 }
    },
    duplicate: {
      ...duplicate,
      venue: duplicateVenue,
      promoter: duplicatePromoter,
      _count: { eventVendors: duplicateEventVendorCount?.count || 0 }
    },
    relationshipsToTransfer,
    warnings,
    canMerge: true,
  };
}

async function mergeEvents(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergeResponse> {
  const transferred: RelationshipCounts = { eventVendors: 0, favorites: 0 };

  // Get vendors already assigned to primary event
  const primaryVendors = await db
    .select({ vendorId: eventVendors.vendorId })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, primaryId));
  const primaryVendorIds = primaryVendors.map(v => v.vendorId);

  // Delete overlapping event_vendor records
  if (primaryVendorIds.length > 0) {
    await db
      .delete(eventVendors)
      .where(and(
        eq(eventVendors.eventId, duplicateId),
        inArray(eventVendors.vendorId, primaryVendorIds)
      ));
  }

  // Transfer remaining event_vendors
  const eventVendorResult = await db
    .update(eventVendors)
    .set({ eventId: primaryId })
    .where(eq(eventVendors.eventId, duplicateId));
  transferred.eventVendors = eventVendorResult.rowsAffected || 0;

  // Combine view counts
  const [duplicate] = await db
    .select({ viewCount: events.viewCount })
    .from(events)
    .where(eq(events.id, duplicateId));

  if (duplicate) {
    await db
      .update(events)
      .set({ viewCount: sql`${events.viewCount} + ${duplicate.viewCount || 0}` })
      .where(eq(events.id, primaryId));
  }

  // Get existing favorites
  const existingFavorites = await db
    .select({ userId: userFavorites.userId })
    .from(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "EVENT"),
      eq(userFavorites.favoritableId, primaryId)
    ));
  const existingUserIds = existingFavorites.map(f => f.userId);

  // Transfer favorites
  if (existingUserIds.length > 0) {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "EVENT"),
        eq(userFavorites.favoritableId, duplicateId),
        notInArray(userFavorites.userId, existingUserIds)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  } else {
    const favoriteResult = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(and(
        eq(userFavorites.favoritableType, "EVENT"),
        eq(userFavorites.favoritableId, duplicateId)
      ));
    transferred.favorites = favoriteResult.rowsAffected || 0;
  }

  // Delete remaining duplicate favorites
  await db
    .delete(userFavorites)
    .where(and(
      eq(userFavorites.favoritableType, "EVENT"),
      eq(userFavorites.favoritableId, duplicateId)
    ));

  // Delete duplicate event
  await db.delete(events).where(eq(events.id, duplicateId));

  const [mergedEntity] = await db.select().from(events).where(eq(events.id, primaryId));
  const [primaryVenue] = await db.select({ name: venues.name }).from(venues).where(eq(venues.id, mergedEntity.venueId));
  const [primaryPromoter] = await db.select({ companyName: promoters.companyName }).from(promoters).where(eq(promoters.id, mergedEntity.promoterId));
  const [eventVendorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, primaryId));

  return {
    success: true,
    mergedEntity: {
      ...mergedEntity,
      venue: primaryVenue,
      promoter: primaryPromoter,
      _count: { eventVendors: eventVendorCount?.count || 0 }
    },
    transferredRelationships: transferred,
    deletedId: duplicateId,
  };
}

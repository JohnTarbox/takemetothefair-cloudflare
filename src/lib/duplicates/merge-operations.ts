import { eq, and, inArray, sql, or, isNull } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  venues,
  events,
  vendors,
  promoters,
  eventVendors,
  userFavorites,
  eventDays,
  eventDataCitations,
  eventSlugHistory,
  contentLinks,
  adminActions,
} from "@/lib/db/schema";
import { unsafeSlug } from "@takemetothefair/utils";
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
 * Execute merge operation.
 *
 * `actorUserId` (K3, 2026-05-31) — recorded in the admin_actions row that
 * mergeEvents writes. Optional so existing venue/vendor/promoter paths
 * (which don't audit through admin_actions yet) keep their signatures.
 */
export async function executeMerge(
  db: Database,
  type: DuplicateEntityType,
  primaryId: string,
  duplicateId: string,
  actorUserId?: string | null
): Promise<MergeResponse> {
  switch (type) {
    case "venues":
      return mergeVenues(db, primaryId, duplicateId);
    case "events":
      return mergeEvents(db, primaryId, duplicateId, actorUserId ?? null);
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
    .where(
      and(eq(userFavorites.favoritableType, "VENUE"), eq(userFavorites.favoritableId, duplicateId))
    );

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

/**
 * Transfer the duplicate entity's favorites onto the keeper, skipping users who
 * already favorited the keeper (those collide on user_favorites'
 * (user_id, favoritable_type, favoritable_id) uniqueness). The colliding
 * dup-favorites are left in place — each merge's cleanup batch deletes the
 * duplicate's remaining favorites afterward.
 *
 * D1-safe by construction: the keeper's favoriter ids are snapshotted into a JS
 * Set and the exclusion is done in MEMORY, then the transfer UPDATEs by PRIMARY
 * KEY in chunks of ≤90 ids. This avoids both failure modes of the old
 * `notInArray(userFavorites.userId, keeperFavoriterIds)`:
 *   (a) binding the keeper's favoriter list, which blows D1's ~100 bound-
 *       variable limit and ABORTS the merge for a >100-favoriter entity; and
 *   (b) a same-table `NOT IN (SELECT…)` subquery in the UPDATE, which trips
 *       better-sqlite3's read-during-write lock and is a prod concurrency risk.
 * Returns the number of favorites transferred.
 */
export async function transferFavorites(
  db: Database,
  favoritableType: "VENUE" | "PROMOTER" | "VENDOR" | "EVENT",
  primaryId: string,
  duplicateId: string
): Promise<number> {
  const keeperFavoriters = await db
    .select({ userId: userFavorites.userId })
    .from(userFavorites)
    .where(
      and(
        eq(userFavorites.favoritableType, favoritableType),
        eq(userFavorites.favoritableId, primaryId)
      )
    );
  const keeperUserIds = new Set(keeperFavoriters.map((f) => f.userId));

  const dupFavorites = await db
    .select({ id: userFavorites.id, userId: userFavorites.userId })
    .from(userFavorites)
    .where(
      and(
        eq(userFavorites.favoritableType, favoritableType),
        eq(userFavorites.favoritableId, duplicateId)
      )
    );
  const transferableIds = dupFavorites.filter((f) => !keeperUserIds.has(f.userId)).map((f) => f.id);
  if (transferableIds.length === 0) return 0;

  // Chunk by PK so each UPDATE stays under D1's ~100 bound-variable cap
  // (the IN list + the one SET value).
  const FAVORITE_TRANSFER_CHUNK = 90;
  let transferred = 0;
  for (let i = 0; i < transferableIds.length; i += FAVORITE_TRANSFER_CHUNK) {
    const res = await db
      .update(userFavorites)
      .set({ favoritableId: primaryId })
      .where(inArray(userFavorites.id, transferableIds.slice(i, i + FAVORITE_TRANSFER_CHUNK)));
    transferred +=
      (res as { meta?: { changes?: number } }).meta?.changes ??
      (res as { rowsAffected?: number }).rowsAffected ??
      0;
  }
  return transferred;
}

async function mergeVenues(
  db: Database,
  primaryId: string,
  duplicateId: string
): Promise<MergeResponse> {
  const transferred: RelationshipCounts = { events: 0, favorites: 0 };

  // Transfer events.
  const [eventResult] = await db.batch([
    db.update(events).set({ venueId: primaryId }).where(eq(events.venueId, duplicateId)),
  ]);
  transferred.events = (eventResult as { rowsAffected?: number }).rowsAffected || 0;

  // Transfer favorites (D1-safe in-memory exclusion + chunked PK transfer).
  transferred.favorites = await transferFavorites(db, "VENUE", primaryId, duplicateId);

  // Batch 2: Cleanup and final fetch
  await db.batch([
    db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.favoritableType, "VENUE"),
          eq(userFavorites.favoritableId, duplicateId)
        )
      ),
    db.delete(venues).where(eq(venues.id, duplicateId)),
  ]);

  // Batch 3: Get merged entity data
  const [mergedResults, countResults] = await db.batch([
    db.select().from(venues).where(eq(venues.id, primaryId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(eq(events.venueId, primaryId)),
  ]);

  const mergedEntity = mergedResults[0];
  const eventCount = countResults[0];

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
    .where(
      and(
        eq(userFavorites.favoritableType, "PROMOTER"),
        eq(userFavorites.favoritableId, duplicateId)
      )
    );

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
  transferred.events = eventResult.meta?.changes ?? 0;

  // Transfer favorites (D1-safe in-memory exclusion + chunked PK transfer).
  transferred.favorites = await transferFavorites(db, "PROMOTER", primaryId, duplicateId);

  // Delete remaining duplicate favorites
  await db
    .delete(userFavorites)
    .where(
      and(
        eq(userFavorites.favoritableType, "PROMOTER"),
        eq(userFavorites.favoritableId, duplicateId)
      )
    );

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
    .where(
      and(eq(userFavorites.favoritableType, "VENDOR"), eq(userFavorites.favoritableId, duplicateId))
    );

  // Check for overlapping events
  const duplicateEventIds = await db
    .select({ eventId: eventVendors.eventId })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, duplicateId));

  const primaryEventIds = await db
    .select({ eventId: eventVendors.eventId })
    .from(eventVendors)
    .where(eq(eventVendors.vendorId, primaryId));

  const primaryEventSet = new Set(primaryEventIds.map((e) => e.eventId));
  const overlappingEvents = duplicateEventIds.filter((e) => primaryEventSet.has(e.eventId));

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
  const primaryEventIds = primaryEvents.map((e) => e.eventId);

  // Delete overlapping event_vendor records
  // D1 has a limit on SQL bind variables, so batch large arrays
  if (primaryEventIds.length > 0) {
    const BATCH_SIZE = 50;
    for (let i = 0; i < primaryEventIds.length; i += BATCH_SIZE) {
      const batch = primaryEventIds.slice(i, i + BATCH_SIZE);
      await db
        .delete(eventVendors)
        .where(and(eq(eventVendors.vendorId, duplicateId), inArray(eventVendors.eventId, batch)));
    }
  }

  // Transfer remaining event_vendors
  const eventVendorResult = await db
    .update(eventVendors)
    .set({ vendorId: primaryId })
    .where(eq(eventVendors.vendorId, duplicateId));
  transferred.eventVendors = eventVendorResult.meta?.changes ?? 0;

  // Transfer favorites (D1-safe in-memory exclusion + chunked PK transfer).
  transferred.favorites = await transferFavorites(db, "VENDOR", primaryId, duplicateId);

  // Delete remaining duplicate favorites
  await db
    .delete(userFavorites)
    .where(
      and(eq(userFavorites.favoritableType, "VENDOR"), eq(userFavorites.favoritableId, duplicateId))
    );

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
  const [primary] = await db.select().from(events).where(eq(events.id, primaryId));

  const [duplicate] = await db.select().from(events).where(eq(events.id, duplicateId));

  if (!primary || !duplicate) {
    throw new Error("One or both events not found");
  }

  // Get venue and promoter info
  const [primaryVenue] = await db
    .select({ name: venues.name })
    .from(venues)
    .where(eq(venues.id, primary.venueId!));
  const [duplicateVenue] = await db
    .select({ name: venues.name })
    .from(venues)
    .where(eq(venues.id, duplicate.venueId!));
  const [primaryPromoter] = await db
    .select({ companyName: promoters.companyName })
    .from(promoters)
    .where(eq(promoters.id, primary.promoterId));
  const [duplicatePromoter] = await db
    .select({ companyName: promoters.companyName })
    .from(promoters)
    .where(eq(promoters.id, duplicate.promoterId));

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
    .where(
      and(eq(userFavorites.favoritableType, "EVENT"), eq(userFavorites.favoritableId, duplicateId))
    );

  // Check for overlapping vendors
  const duplicateVendorIds = await db
    .select({ vendorId: eventVendors.vendorId })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, duplicateId));

  const primaryVendorIds = await db
    .select({ vendorId: eventVendors.vendorId })
    .from(eventVendors)
    .where(eq(eventVendors.eventId, primaryId));

  const primaryVendorSet = new Set(primaryVendorIds.map((v) => v.vendorId));
  const overlappingVendors = duplicateVendorIds.filter((v) => primaryVendorSet.has(v.vendorId));

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
      _count: { eventVendors: primaryEventVendorCount?.count || 0 },
    },
    duplicate: {
      ...duplicate,
      venue: duplicateVenue,
      promoter: duplicatePromoter,
      _count: { eventVendors: duplicateEventVendorCount?.count || 0 },
    },
    relationshipsToTransfer,
    warnings,
    canMerge: true,
  };
}

/**
 * Merge a duplicate event INTO a keeper, preserving SEO equity.
 *
 * K3 (analyst, 2026-05-31) rewrote the original "delete the duplicate
 * row" semantics into "tombstone + slug redirect" semantics because:
 *
 *   - eventSlugHistory.eventId has onDelete: cascade. Deleting the
 *     duplicate would cascade-delete any slug-history rows pointing at
 *     it, killing the 301 redirect we need to preserve.
 *   - middleware.ts:179 returns 410 Gone for any REJECTED event at its
 *     own slug, which would BEAT a slug-history 301. So leaving the
 *     duplicate REJECTED at its original slug is also wrong.
 *
 * The K3 dance:
 *   1. Rename the duplicate's slug to `<orig>-merged-<first-8-of-id>`
 *      so the URL is free.
 *   2. Insert event_slug_history (eventId=keeper, oldSlug=original-dup,
 *      newSlug=keeper-slug). FK to keeper so any future cascade behaves.
 *   3. Mark duplicate status='REJECTED', merged_into=keeperId. The row
 *      stays around as an audit tombstone.
 *   4. Transfer FK children: event_vendors, event_days, event_data_
 *      citations, content_links (target_type='EVENT'), user_favorites.
 *      view_count adds on the keeper.
 *   5. Write admin_actions row with action='event.merge'.
 *
 * After this, /events/<original-dup-slug> walks the slug-history chain
 * in middleware.ts → 301 to /events/<keeper-slug>. Tombstone row is
 * queryable for audit (slug = `*-merged-*`) but not publicly visible
 * (status='REJECTED' → middleware returns 410 at its renamed slug,
 * which nothing links to).
 */
async function mergeEvents(
  db: Database,
  primaryId: string,
  duplicateId: string,
  actorUserId: string | null = null
): Promise<MergeResponse> {
  const transferred: RelationshipCounts = { eventVendors: 0, favorites: 0 };

  // Batch 1: Load primary + duplicate snapshots + overlap-prep selects
  // in parallel. We need keeper.slug for the slug-history row, dup.slug
  // for the rename + history old_slug, and dup.viewCount for the sum-on-
  // keeper.
  const [primaryVendors, primarySnap, duplicateSnap] = await db.batch([
    db
      .select({ vendorId: eventVendors.vendorId })
      .from(eventVendors)
      .where(eq(eventVendors.eventId, primaryId)),
    db
      .select({
        slug: events.slug,
        viewCount: events.viewCount,
        // K-bundle followup (2026-05-31): source fields read so the
        // source_url-transfer step below can fill in any keeper NULLs
        // from the duplicate. Without this, the K-bundle's first 4
        // production merges (Winthrop / Kids Con / Bonny Eagle /
        // ComicCon) dropped the duplicate's source_url silently.
        sourceUrl: events.sourceUrl,
        sourceDomain: events.sourceDomain,
        sourceId: events.sourceId,
        sourceName: events.sourceName,
      })
      .from(events)
      .where(eq(events.id, primaryId)),
    db
      .select({
        slug: events.slug,
        viewCount: events.viewCount,
        mergedInto: events.mergedInto,
        sourceUrl: events.sourceUrl,
        sourceDomain: events.sourceDomain,
        sourceId: events.sourceId,
        sourceName: events.sourceName,
      })
      .from(events)
      .where(eq(events.id, duplicateId)),
  ]);

  const primaryVendorIds = primaryVendors.map((v) => v.vendorId);
  const keeper = primarySnap[0];
  const duplicate = duplicateSnap[0];

  if (!keeper || !duplicate) {
    throw new Error("mergeEvents: keeper or duplicate not found");
  }
  if (primaryId === duplicateId) {
    throw new Error("mergeEvents: keeper and duplicate are the same event");
  }
  if (duplicate.mergedInto) {
    throw new Error(`mergeEvents: duplicate ${duplicateId} is already merged`);
  }

  // K3 Step 1: rename the duplicate's slug to free the URL. Suffix is
  // the first 8 chars of the duplicate id — small enough to be ugly
  // (operators never link to it) and unique enough that a re-merge
  // wouldn't collide on the slug UNIQUE constraint.
  const originalDupSlug = duplicate.slug;
  const renamedDupSlug = unsafeSlug(`${originalDupSlug}-merged-${duplicateId.slice(0, 8)}`);

  // Transfer overlap-cleanup for event_vendors (D1 bound-param limit
  // applies, hence the BATCH_SIZE chunking — see
  // [[feedback_d1_batch_param_limit]]).
  if (primaryVendorIds.length > 0) {
    const BATCH_SIZE = 50;
    for (let i = 0; i < primaryVendorIds.length; i += BATCH_SIZE) {
      const batch = primaryVendorIds.slice(i, i + BATCH_SIZE);
      await db
        .delete(eventVendors)
        .where(and(eq(eventVendors.eventId, duplicateId), inArray(eventVendors.vendorId, batch)));
    }
  }

  // Transfer remaining event_vendors.
  const eventVendorResult = await db
    .update(eventVendors)
    .set({ eventId: primaryId })
    .where(eq(eventVendors.eventId, duplicateId));
  transferred.eventVendors = (eventVendorResult as { rowsAffected?: number }).rowsAffected || 0;

  // K3 — transfer event_days, event_data_citations, and content_links.
  // event_days has no DB-level UNIQUE on (eventId, date) but
  // semantically two rows for the same day on the same event are wrong
  // (we'd render a duplicated Saturday slot). Pre-delete dup rows that
  // collide on date with a keeper row, mirroring the event_vendors
  // overlap-cleanup pattern.
  // The KEEPER's existing day dates — any duplicate day on one of these dates is
  // a collision and must be DELETED (not transferred), or the keeper would end up
  // with two rows for the same day. (Naming: this is the keeper's set; we use it
  // to filter the duplicate's days.)
  const keeperDayDates = await db
    .select({ date: eventDays.date })
    .from(eventDays)
    .where(eq(eventDays.eventId, primaryId));
  if (keeperDayDates.length > 0) {
    const dates = keeperDayDates.map((d) => d.date);
    const BATCH_SIZE = 50;
    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
      const batch = dates.slice(i, i + BATCH_SIZE);
      await db
        .delete(eventDays)
        .where(and(eq(eventDays.eventId, duplicateId), inArray(eventDays.date, batch)));
    }
  }
  // Transfer the duplicate's remaining (non-colliding) days to the keeper.
  await db.update(eventDays).set({ eventId: primaryId }).where(eq(eventDays.eventId, duplicateId));

  await db
    .update(eventDataCitations)
    .set({ eventId: primaryId })
    .where(eq(eventDataCitations.eventId, duplicateId));

  // content_links: blog mentions of the duplicate event. Update both
  // targetId AND targetSlug to point at the keeper — preserves the
  // "blog X links to event Y" relationship through the merge. Older
  // legacy content_links may have a targetSlug but null targetId; the
  // slug-history walker in middleware.ts handles the redirect at read
  // time, but pointing the row at the keeper here is the more useful
  // canonical fix.
  //
  // K9 (analyst, 2026-06-01). Pre-delete duplicate-side rows that would
  // collide on UNIQUE(source_type, source_id, target_type, target_slug)
  // when repointed to keeper.slug. Surfaced 2026-05-31 during the Bar
  // Harbor Holiday Craft Fair merge — blog post 8ede7fd4 carried
  // content_links to BOTH events; the blind UPDATE below would have
  // produced a duplicate row and thrown D1_ERROR: UNIQUE constraint
  // failed, rolling back the whole merge. Mirrors the event_days
  // overlap-cleanup pattern at lines 750-763.
  //
  // The unique index is declared as a plain index() in the Drizzle
  // schema (packages/db-schema/src/index.ts:808) but the migration
  // drizzle/0086_widen_content_links_target_type.sql creates it as a
  // UNIQUE INDEX, so the constraint is real at runtime — the typing
  // gap is why tsc never caught it.
  //
  // We select keeper-side keys (rows where the link already points at
  // keeper.slug), then delete any duplicate-side rows that share the
  // same (sourceType, sourceId). A dup-side row matches via either the
  // modern shape (targetId = duplicateId) or the legacy shape
  // (targetId IS NULL AND targetSlug = originalDupSlug).
  const keeperContentLinks = await db
    .select({
      sourceType: contentLinks.sourceType,
      sourceId: contentLinks.sourceId,
    })
    .from(contentLinks)
    .where(and(eq(contentLinks.targetType, "EVENT"), eq(contentLinks.targetSlug, keeper.slug)));
  if (keeperContentLinks.length > 0) {
    // One DELETE per collision pair. Each statement binds ~5 params
    // (well under the D1 100-param cap per [[feedback_d1_batch_param_limit]])
    // and the typical case is a single colliding blog post.
    for (const { sourceType, sourceId } of keeperContentLinks) {
      await db
        .delete(contentLinks)
        .where(
          and(
            eq(contentLinks.targetType, "EVENT"),
            eq(contentLinks.sourceType, sourceType),
            eq(contentLinks.sourceId, sourceId),
            or(
              eq(contentLinks.targetId, duplicateId),
              and(isNull(contentLinks.targetId), eq(contentLinks.targetSlug, originalDupSlug))
            )
          )
        );
    }
  }

  await db
    .update(contentLinks)
    .set({ targetId: primaryId, targetSlug: keeper.slug })
    .where(and(eq(contentLinks.targetType, "EVENT"), eq(contentLinks.targetId, duplicateId)));
  // Also catch legacy rows that have the duplicate's slug but null id.
  await db
    .update(contentLinks)
    .set({ targetId: primaryId, targetSlug: keeper.slug })
    .where(and(eq(contentLinks.targetType, "EVENT"), eq(contentLinks.targetSlug, originalDupSlug)));

  // Combine view counts — keeper.viewCount += duplicate.viewCount.
  await db
    .update(events)
    .set({ viewCount: sql`${events.viewCount} + ${duplicate.viewCount || 0}` })
    .where(eq(events.id, primaryId));

  // K-bundle followup (analyst, 2026-05-31). Copy source-* fields from
  // duplicate → keeper ONLY when the keeper's value is NULL. Hit twice
  // in K-bundle dogfood (Kids Con + Bonny Eagle: keeper had no
  // source_url but duplicate did; merging dropped the URL). Conservative
  // by design — never overwrite an existing keeper value, never copy a
  // NULL FROM the duplicate, and assemble the update set inline so an
  // empty {} (keeper already populated) skips the round-trip.
  const sourceTransferUpdates: Partial<{
    sourceUrl: string;
    sourceDomain: string;
    sourceId: string;
    sourceName: string;
  }> = {};
  if (!keeper.sourceUrl && duplicate.sourceUrl) {
    sourceTransferUpdates.sourceUrl = duplicate.sourceUrl;
  }
  if (!keeper.sourceDomain && duplicate.sourceDomain) {
    sourceTransferUpdates.sourceDomain = duplicate.sourceDomain;
  }
  if (!keeper.sourceId && duplicate.sourceId) {
    sourceTransferUpdates.sourceId = duplicate.sourceId;
  }
  if (!keeper.sourceName && duplicate.sourceName) {
    sourceTransferUpdates.sourceName = duplicate.sourceName;
  }
  if (Object.keys(sourceTransferUpdates).length > 0) {
    await db.update(events).set(sourceTransferUpdates).where(eq(events.id, primaryId));
  }

  // Transfer favorites with collision-avoidance (a single user can only
  // favorite the same event once). Moves only non-colliding dup rows; the
  // colliding ones are deleted in the cleanup batch below. D1-safe in-memory
  // exclusion + chunked PK transfer.
  transferred.favorites = await transferFavorites(db, "EVENT", primaryId, duplicateId);

  // K3 Steps 1-3 + cleanup, in one db.batch so the slug rename + history
  // insert + status update are atomic. Order matters: the rename must
  // commit BEFORE the history row is inserted, so eventSlugHistory's
  // unique-on-(oldSlug) (if present in production schema) doesn't trip.
  // We insert with eventId = primaryId (the keeper) so future cascade-
  // deletes of the keeper would take the history with them — which is
  // intentional: if the keeper is gone, the redirect target is gone too.
  await db.batch([
    // Drop any remaining user_favorites on the duplicate that collided.
    db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.favoritableType, "EVENT"),
          eq(userFavorites.favoritableId, duplicateId)
        )
      ),
    // Step 1: rename the duplicate's slug to free the URL.
    db.update(events).set({ slug: renamedDupSlug }).where(eq(events.id, duplicateId)),
    // Step 2: insert the slug-history row so /events/<original-dup-slug>
    // → 301 → /events/<keeper-slug> via middleware.ts.
    db.insert(eventSlugHistory).values({
      eventId: primaryId,
      oldSlug: originalDupSlug,
      newSlug: keeper.slug,
      changedAt: new Date(),
      changedBy: actorUserId,
    }),
    // Step 3: mark the duplicate REJECTED + record the merged-into
    // pointer. Status REJECTED at the renamed slug → middleware returns
    // 410 Gone (nothing links to the renamed slug, so this is silent).
    db
      .update(events)
      .set({ status: "REJECTED", mergedInto: primaryId, updatedAt: new Date() })
      .where(eq(events.id, duplicateId)),
    // Step 5: admin_actions audit row.
    db.insert(adminActions).values({
      action: "event.merge",
      actorUserId,
      targetType: "event",
      targetId: primaryId,
      payloadJson: JSON.stringify({
        duplicateId,
        duplicateSlugOriginal: originalDupSlug,
        duplicateSlugRenamed: renamedDupSlug,
        keeperSlug: keeper.slug,
        transferred,
      }),
      createdAt: new Date(),
    }),
  ]);

  // Final fetch: return the merged keeper with its venue + promoter
  // join. Same shape the original mergeEvents returned for backwards
  // compatibility with any UI that consumes MergeResponse.
  const [mergedResults, venueResults, promoterResults, countResults] = await db.batch([
    db.select().from(events).where(eq(events.id, primaryId)),
    db
      .select({ name: venues.name })
      .from(venues)
      .where(sql`${venues.id} = (SELECT venue_id FROM events WHERE id = ${primaryId})`),
    db
      .select({ companyName: promoters.companyName })
      .from(promoters)
      .where(sql`${promoters.id} = (SELECT promoter_id FROM events WHERE id = ${primaryId})`),
    db
      .select({ count: sql<number>`count(*)` })
      .from(eventVendors)
      .where(eq(eventVendors.eventId, primaryId)),
  ]);

  const mergedEntity = mergedResults[0];
  const primaryVenue = venueResults[0];
  const primaryPromoter = promoterResults[0];
  const eventVendorCount = countResults[0];

  return {
    success: true,
    mergedEntity: {
      ...mergedEntity,
      venue: primaryVenue,
      promoter: primaryPromoter,
      _count: { eventVendors: eventVendorCount?.count || 0 },
    },
    transferredRelationships: transferred,
    // `deletedId` is now misnamed — the row isn't deleted, it's
    // tombstoned. Kept for the existing MergeResponse contract; the
    // admin UI doesn't behaviorally depend on the row being gone.
    deletedId: duplicateId,
  };
}

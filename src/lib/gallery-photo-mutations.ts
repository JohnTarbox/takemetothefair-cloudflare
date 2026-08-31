/**
 * OPE-686 — delete, reorder and rotate, for BOTH galleries.
 *
 * `event_photos` and `vendor_photos` are the same shape and have already
 * drifted once: the event route hard-deleted its row while claiming, in a
 * comment, that the delete was recoverable. It was not — the R2 object
 * survived, but the id, caption, sort order and featured flag that would let
 * anyone find it did not.
 *
 * So the rules live here once, parameterised by which table is in play, and
 * both routes call the same function. The decision rules themselves
 * (`pickFeaturedSuccessor`, `applyRotation`) are pure and live in
 * `@takemetothefair/db-schema`, where they are tested without a database.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { adminActions, eventPhotos, vendorPhotos } from "@/lib/db/schema";
import { pickFeaturedSuccessor, applyRotation } from "@takemetothefair/db-schema";
import type { Db } from "@/lib/analytics-overview/shared";

export type GalleryTarget = "event" | "vendor";

export interface GalleryRow {
  id: string;
  sortOrder: number;
  isFeatured: boolean;
  rotation: number;
  caption: string | null;
  photoUrl: string;
}

/** Read one owner's LIVE gallery, in display order. */
export async function readGallery(
  db: Db,
  target: GalleryTarget,
  ownerId: string
): Promise<GalleryRow[]> {
  if (target === "event") {
    return db
      .select({
        id: eventPhotos.id,
        sortOrder: eventPhotos.sortOrder,
        isFeatured: eventPhotos.isFeatured,
        rotation: eventPhotos.rotation,
        caption: eventPhotos.caption,
        photoUrl: eventPhotos.photoUrl,
      })
      .from(eventPhotos)
      .where(and(eq(eventPhotos.eventId, ownerId), isNull(eventPhotos.deletedAt)))
      .orderBy(asc(eventPhotos.sortOrder));
  }
  return db
    .select({
      id: vendorPhotos.id,
      sortOrder: vendorPhotos.sortOrder,
      isFeatured: vendorPhotos.isFeatured,
      rotation: vendorPhotos.rotation,
      caption: vendorPhotos.caption,
      photoUrl: vendorPhotos.photoUrl,
    })
    .from(vendorPhotos)
    .where(and(eq(vendorPhotos.vendorId, ownerId), isNull(vendorPhotos.deletedAt)))
    .orderBy(asc(vendorPhotos.sortOrder));
}

async function setPhoto(
  db: Db,
  target: GalleryTarget,
  photoId: string,
  values: Record<string, unknown>
) {
  if (target === "event") {
    await db.update(eventPhotos).set(values).where(eq(eventPhotos.id, photoId));
    return;
  }
  await db.update(vendorPhotos).set(values).where(eq(vendorPhotos.id, photoId));
}

export interface DeleteResult {
  deleted: string;
  /** Set when the deleted photo was the gallery's lead and another took over. */
  promoted: string | null;
  /** The gallery as it now stands, so the caller can verify without a re-read. */
  remaining: GalleryRow[];
}

/**
 * Soft-delete one photo, promote a successor if it was the lead, and record it.
 *
 * The promotion is the part that is easy to leave out and hard to notice
 * missing: a gallery whose lead photo is deleted and left headless renders on
 * the public page exactly like a gallery nobody has curated.
 *
 * Idempotent. Deleting an already-deleted photo is a no-op that returns the
 * current gallery rather than an error — an agent retrying a timed-out call
 * should not have to distinguish "it failed" from "it worked and I missed the
 * reply".
 */
export async function softDeleteGalleryPhoto(
  db: Db,
  opts: {
    target: GalleryTarget;
    ownerId: string;
    photoId: string;
    actorUserId?: string | null;
    via?: string;
  }
): Promise<DeleteResult> {
  const now = new Date();
  const before = await readGallery(db, opts.target, opts.ownerId);

  if (!before.some((p) => p.id === opts.photoId)) {
    return { deleted: opts.photoId, promoted: null, remaining: before };
  }

  const successor = pickFeaturedSuccessor(before, opts.photoId);

  await setPhoto(db, opts.target, opts.photoId, {
    deletedAt: now,
    isFeatured: false,
    updatedAt: now,
  });

  if (successor) {
    await setPhoto(db, opts.target, successor.id, { isFeatured: true, updatedAt: now });
  }

  await db.insert(adminActions).values({
    action: "gallery.photo_deleted",
    actorUserId: opts.actorUserId ?? null,
    targetType: opts.target,
    targetId: opts.ownerId,
    payloadJson: JSON.stringify({
      photoId: opts.photoId,
      promotedPhotoId: successor?.id ?? null,
      via: opts.via ?? "api",
      // Soft, so the row is still there to restore. Named explicitly because
      // the previous route's comment claimed recoverability it did not have.
      reversible: true,
    }),
    createdAt: now,
  });

  return {
    deleted: opts.photoId,
    promoted: successor?.id ?? null,
    remaining: await readGallery(db, opts.target, opts.ownerId),
  };
}

/**
 * Turn a photo by a relative number of degrees, in place.
 *
 * Nothing about the stored object changes: `photo_id`, `sort_order`,
 * `is_featured` and the caption survive by construction rather than by being
 * carefully copied to a new row, which is what the download-rotate-reupload
 * workaround did — and it minted a new URL every time.
 */
export async function rotateGalleryPhoto(
  db: Db,
  opts: {
    target: GalleryTarget;
    ownerId: string;
    photoId: string;
    degrees: number;
    actorUserId?: string | null;
    via?: string;
  }
): Promise<{ photoId: string; rotation: number } | null> {
  const gallery = await readGallery(db, opts.target, opts.ownerId);
  const row = gallery.find((p) => p.id === opts.photoId);
  if (!row) return null;

  const next = applyRotation(row.rotation ?? 0, opts.degrees);
  const now = new Date();
  await setPhoto(db, opts.target, opts.photoId, { rotation: next, updatedAt: now });

  await db.insert(adminActions).values({
    action: "gallery.photo_rotated",
    actorUserId: opts.actorUserId ?? null,
    targetType: opts.target,
    targetId: opts.ownerId,
    payloadJson: JSON.stringify({
      photoId: opts.photoId,
      from: row.rotation ?? 0,
      to: next,
      via: opts.via ?? "api",
    }),
    createdAt: now,
  });

  return { photoId: opts.photoId, rotation: next };
}

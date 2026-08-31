export const dynamic = "force-dynamic";
/**
 * OPE-212 §5 — edit or delete one event gallery photo. ADMIN ONLY.
 *
 * `is_featured` marks the GALLERY's own lead photo. It does not touch
 * `events.image_url`, which stays the canonical hero — John's greenlight:
 * "existing events.image_url remains the canonical hero; gallery is_featured
 * is only its own lead." That separation is what makes OPE-204/205's
 * "hero-if-blank" writes structurally unable to be clobbered by a gallery edit.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAuth } from "@/lib/api/with-auth";
import { eventPhotos } from "@/lib/db/schema";
import { decodeHtmlEntities } from "@/lib/utils";
import { softDeleteGalleryPhoto, rotateGalleryPhoto } from "@/lib/gallery-photo-mutations";

const patchSchema = z.object({
  caption: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  altText: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  photoType: z.enum(["midway", "vendors", "food", "stage", "other"]).optional(),
  isFeatured: z.boolean().optional(),
  /** OPE-686 — the arrow buttons' effect, addressable without the reorder route. */
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /**
   * OPE-686 — a RELATIVE turn, because that is what the operator sees: a
   * sideways photo they want turned a quarter. An absolute angle would make
   * every caller read the current value first, and the one that forgets
   * silently un-rotates a photo somebody already fixed.
   */
  rotateBy: z
    .number()
    .int()
    .refine((n) => Math.abs(n) % 90 === 0, "rotateBy must be a multiple of 90")
    .optional(),
});

export const PATCH = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params, session }) => {
    const { id } = params;

    const [existing] = await db
      .select({ eventId: eventPhotos.eventId, deletedAt: eventPhotos.deletedAt })
      .from(eventPhotos)
      .where(eq(eventPhotos.id, id))
      .limit(1);
    if (!existing) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
    // A tombstone is not editable. Without this a PATCH would quietly revive a
    // deleted photo's caption and featured flag while it stayed invisible.
    if (existing.deletedAt)
      return NextResponse.json({ error: "Photo has been deleted" }, { status: 410 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", detail: parsed.error.issues.map((i) => i.message) },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.caption !== undefined) updates.caption = parsed.data.caption ?? null;
    if (parsed.data.altText !== undefined) updates.altText = parsed.data.altText ?? null;
    if (parsed.data.photoType !== undefined) updates.photoType = parsed.data.photoType;
    if (parsed.data.sortOrder !== undefined) updates.sortOrder = parsed.data.sortOrder;

    // Exclusive per event, enforced server-side so two concurrent promotions
    // cannot both stick.
    if (parsed.data.isFeatured === true) {
      await db
        .update(eventPhotos)
        .set({ isFeatured: false, updatedAt: new Date() })
        .where(eq(eventPhotos.eventId, existing.eventId));
      updates.isFeatured = true;
    } else if (parsed.data.isFeatured === false) {
      updates.isFeatured = false;
    }

    await db.update(eventPhotos).set(updates).where(eq(eventPhotos.id, id));

    let rotation: number | undefined;
    if (parsed.data.rotateBy !== undefined) {
      const res = await rotateGalleryPhoto(db, {
        target: "event",
        ownerId: existing.eventId,
        photoId: id,
        degrees: parsed.data.rotateBy,
        actorUserId: session?.user?.id ?? null,
      });
      rotation = res?.rotation;
    }

    return NextResponse.json({ success: true, id, ...(rotation != null ? { rotation } : {}) });
  }
);

export const DELETE = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ db, params, session }) => {
    // OPE-686 — SOFT delete. This route used to `db.delete` the row while its
    // comment claimed the surviving R2 object made an accidental delete
    // recoverable. It did not: recovering meant knowing the id, caption, sort
    // order and featured flag that had just been destroyed. The tombstone keeps
    // them, and the featured photo's successor is promoted so the gallery is not
    // left headless.
    const [existing] = await db
      .select({ eventId: eventPhotos.eventId })
      .from(eventPhotos)
      .where(eq(eventPhotos.id, params.id))
      .limit(1);
    if (!existing) return NextResponse.json({ error: "Photo not found" }, { status: 404 });

    const result = await softDeleteGalleryPhoto(db, {
      target: "event",
      ownerId: existing.eventId,
      photoId: params.id,
      actorUserId: session?.user?.id ?? null,
    });
    return NextResponse.json({ success: true, id: params.id, ...result });
  }
);

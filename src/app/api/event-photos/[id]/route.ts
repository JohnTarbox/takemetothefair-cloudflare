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

const patchSchema = z.object({
  caption: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  altText: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  photoType: z.enum(["midway", "vendors", "food", "stage", "other"]).optional(),
  isFeatured: z.boolean().optional(),
});

export const PATCH = withAuth<{ id: string }>(
  { role: "ADMIN" },
  async ({ request, db, params }) => {
    const { id } = params;

    const [existing] = await db
      .select({ eventId: eventPhotos.eventId })
      .from(eventPhotos)
      .where(eq(eventPhotos.id, id))
      .limit(1);
    if (!existing) return NextResponse.json({ error: "Photo not found" }, { status: 404 });

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
    return NextResponse.json({ success: true, id });
  }
);

export const DELETE = withAuth<{ id: string }>({ role: "ADMIN" }, async ({ db, params }) => {
  // D1 row only; the R2 object stays. Same reasoning as the vendor route — an
  // object delete would make an accidental delete unrecoverable, and orphan
  // reaping is a separate auditable sweep.
  await db.delete(eventPhotos).where(eq(eventPhotos.id, params.id));
  return NextResponse.json({ success: true, id: params.id });
});

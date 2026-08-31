export const dynamic = "force-dynamic";
/**
 * OPE-211 increments 2b + 3 — edit or delete one vendor gallery photo.
 *
 * Serves BOTH the admin UI and the vendor self-service UI. One route, one
 * authorization function (`authorizePhotoMutation`), because the two callers
 * differ only in who passes the check — and a duplicated check is how the
 * public-facing copy drifts more permissive than the staff one.
 *
 * Legacy `gallery_images` JSON entries have no row here and therefore no id,
 * so they cannot be edited through this route. That is correct: they are not
 * `vendor_photos` rows until increment 4's STOP-gated backfill runs.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendorPhotos } from "@/lib/db/schema";
import { authorizePhotoMutation } from "@/lib/vendor-photo-auth";
import { decodeHtmlEntities } from "@/lib/utils";
import { softDeleteGalleryPhoto, rotateGalleryPhoto } from "@/lib/gallery-photo-mutations";

/** Caption/alt are free text from a user — decoded at the schema boundary. */
const patchSchema = z.object({
  caption: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  altText: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  photoType: z.enum(["booth", "product", "owner", "other"]).optional(),
  isFeatured: z.boolean().optional(),
  /** OPE-686 — same additions as the event route; see it for the reasoning. */
  sortOrder: z.number().int().min(0).max(9999).optional(),
  rotateBy: z
    .number()
    .int()
    .refine((n) => Math.abs(n) % 90 === 0, "rotateBy must be a multiple of 90")
    .optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth();
  const db = getCloudflareDb();

  const gate = await authorizePhotoMutation(db, id, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  // OPE-686 — a tombstone is not editable. Without this a PATCH would quietly
  // revive a deleted photo's caption and featured flag while it stayed
  // invisible on every surface.
  if (gate.deleted) return NextResponse.json({ error: "Photo has been deleted" }, { status: 410 });

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

  // Featured is exclusive per vendor: promoting one demotes the rest. Doing it
  // in the route rather than trusting the client keeps the invariant true even
  // if a caller sets two photos featured in parallel.
  if (parsed.data.isFeatured === true) {
    await db
      .update(vendorPhotos)
      .set({ isFeatured: false, updatedAt: new Date() })
      .where(eq(vendorPhotos.vendorId, gate.vendorId));
    updates.isFeatured = true;
  } else if (parsed.data.isFeatured === false) {
    updates.isFeatured = false;
  }

  await db.update(vendorPhotos).set(updates).where(eq(vendorPhotos.id, id));

  let rotation: number | undefined;
  if (parsed.data.rotateBy !== undefined) {
    const res = await rotateGalleryPhoto(db, {
      target: "vendor",
      ownerId: gate.vendorId,
      photoId: id,
      degrees: parsed.data.rotateBy,
      actorUserId: session?.user?.id ?? null,
    });
    rotation = res?.rotation;
  }

  return NextResponse.json({ success: true, id, ...(rotation != null ? { rotation } : {}) });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth();
  const db = getCloudflareDb();

  const gate = await authorizePhotoMutation(db, id, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // OPE-686 — SOFT delete. Leaving the R2 object was never enough to make an
  // accidental delete recoverable: restoring meant knowing the id, caption,
  // sort order and featured flag that the hard delete had just destroyed. The
  // tombstone keeps them, and a deleted lead photo hands off to its successor
  // instead of leaving the gallery headless.
  const result = await softDeleteGalleryPhoto(db, {
    target: "vendor",
    ownerId: gate.vendorId,
    photoId: id,
    actorUserId: session?.user?.id ?? null,
  });
  return NextResponse.json({ success: true, id, ...result });
}

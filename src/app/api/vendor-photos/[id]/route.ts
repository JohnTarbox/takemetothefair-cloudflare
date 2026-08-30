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

/** Caption/alt are free text from a user — decoded at the schema boundary. */
const patchSchema = z.object({
  caption: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  altText: z.string().max(300).transform(decodeHtmlEntities).nullish(),
  photoType: z.enum(["booth", "product", "owner", "other"]).optional(),
  isFeatured: z.boolean().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth();
  const db = getCloudflareDb();

  const gate = await authorizePhotoMutation(db, id, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

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
  return NextResponse.json({ success: true, id });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await auth();
  const db = getCloudflareDb();

  const gate = await authorizePhotoMutation(db, id, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  // The D1 row goes; the R2 object is deliberately left. Objects are content-
  // addressed by timestamped key and cheap, and a delete that removed the
  // object would make an accidental delete unrecoverable. Reaping orphans is a
  // separate, auditable sweep.
  await db.delete(vendorPhotos).where(eq(vendorPhotos.id, id));
  return NextResponse.json({ success: true, id });
}

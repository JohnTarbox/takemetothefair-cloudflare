export const dynamic = "force-dynamic";
/**
 * OPE-211 increments 2b + 3 — reorder a vendor's gallery.
 *
 * ── The check that is easy to miss ────────────────────────────────────────
 *
 * Authorising the VENDOR is not sufficient. A caller who legitimately owns
 * vendor A could send A's id with a photo-id list containing one of vendor B's
 * photos, and a naive `UPDATE vendor_photos SET sort_order = ? WHERE id = ?`
 * would happily renumber B's photo — a cross-tenant write from a request that
 * passed authorization. `assertPhotosBelongTo` closes it, and the ids are
 * re-fetched from the DB rather than trusted from the body.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendorPhotos } from "@/lib/db/schema";
import { authorizeVendorGallery, assertPhotosBelongTo } from "@/lib/vendor-photo-auth";

const reorderSchema = z.object({
  vendorId: z.string().min(1),
  // Bounded: the gallery cap is ~20, and an unbounded list is an unbounded
  // number of UPDATEs from one request.
  photoIds: z.array(z.string().min(1)).min(1).max(100),
});

export async function POST(request: Request) {
  const session = await auth();
  const db = getCloudflareDb();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.issues.map((i) => i.message) },
      { status: 400 }
    );
  }
  const { vendorId, photoIds } = parsed.data;

  const gate = await authorizeVendorGallery(db, vendorId, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const owned = await db
    .select({ id: vendorPhotos.id })
    .from(vendorPhotos)
    .where(eq(vendorPhotos.vendorId, vendorId));

  const belong = assertPhotosBelongTo(
    photoIds,
    owned.map((r) => r.id)
  );
  if (!belong.ok) {
    return NextResponse.json(
      { error: "One or more photos do not belong to this vendor", foreign: belong.foreign },
      { status: 400 }
    );
  }

  const now = new Date();
  // Sequential rather than a batch: the list is capped at 100 and D1's batch
  // takes at most 100 bound parameters, which two-parameter statements would
  // exhaust at 50 rows. A loop is slower and cannot silently truncate.
  for (let i = 0; i < photoIds.length; i++) {
    await db
      .update(vendorPhotos)
      .set({ sortOrder: i, updatedAt: now })
      .where(eq(vendorPhotos.id, photoIds[i]));
  }

  return NextResponse.json({ success: true, reordered: photoIds.length });
}

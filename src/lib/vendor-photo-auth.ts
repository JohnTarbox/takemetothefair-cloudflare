/**
 * OPE-211 increments 2b + 3 — who may edit a vendor's photos.
 *
 * ONE authorization function, shared by the admin routes and the vendor
 * self-service routes, because the two differ only in who passes. Writing the
 * check twice is how a self-service path ends up subtly more permissive than
 * the admin one it was copied from — and the permissive copy is the one
 * exposed to the public internet.
 *
 * John's greenlight (2026-07-15) sets the boundary precisely:
 *   ✅ "authenticated vendor uploads to THEIR OWN vendor row"
 *   ✅ "reorder + set-featured + delete on rows they own"
 *   ❌ "any public write from an unauthenticated vendor — session-required"
 *   ✅ "Admin retains override — staff can delete or reorder any vendor's
 *      photos even after the vendor uploaded"
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { vendors, vendorPhotos } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

/**
 * John's greenlight: "upper-bounded gallery size (whatever the spec/UX picks;
 * sane default ~20 photos)".
 *
 * Lives here rather than in the upload route because a Next.js route file may
 * only export handlers and known config — exporting a constant from one fails
 * the build with "does not match the required types of a Next.js Route", which
 * is how this landed here.
 */
export const MAX_GALLERY_PHOTOS = 20;

export type PhotoAuthResult =
  | { ok: true; vendorId: string; isAdmin: boolean }
  | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * May `userId` (with `role`) modify `photoId`?
 *
 * Returns 404 for a photo that does not exist AND for one the caller does not
 * own — deliberately the same answer. A distinct 403 would let any logged-in
 * user enumerate which photo ids exist by probing, which is a small leak but a
 * free one to avoid.
 */
export async function authorizePhotoMutation(
  db: Db,
  photoId: string,
  userId: string | null | undefined,
  role: string | null | undefined
): Promise<PhotoAuthResult> {
  if (!userId) return { ok: false, status: 401, error: "Unauthorized" };
  const isAdmin = role === "ADMIN";

  const rows = await db
    .select({ vendorId: vendorPhotos.vendorId, ownerId: vendors.userId })
    .from(vendorPhotos)
    .innerJoin(vendors, eq(vendors.id, vendorPhotos.vendorId))
    .where(eq(vendorPhotos.id, photoId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Photo not found" };
  if (!isAdmin && row.ownerId !== userId) {
    return { ok: false, status: 404, error: "Photo not found" };
  }
  return { ok: true, vendorId: row.vendorId, isAdmin };
}

/**
 * May `userId` modify the gallery of `vendorId` as a whole (reorder)?
 *
 * Separate from the per-photo check because reorder takes a vendor + a list of
 * ids, and checking only the vendor would let a caller splice another vendor's
 * photo id into the list. The route must ALSO verify every id belongs to this
 * vendor — see `assertPhotosBelongTo`.
 */
export async function authorizeVendorGallery(
  db: Db,
  vendorId: string,
  userId: string | null | undefined,
  role: string | null | undefined
): Promise<PhotoAuthResult> {
  if (!userId) return { ok: false, status: 401, error: "Unauthorized" };
  const isAdmin = role === "ADMIN";

  const rows = await db
    .select({ ownerId: vendors.userId })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Vendor not found" };
  if (!isAdmin && row.ownerId !== userId) {
    return { ok: false, status: 404, error: "Vendor not found" };
  }
  return { ok: true, vendorId, isAdmin };
}

/**
 * Every id in `photoIds` belongs to `vendorId`.
 *
 * The reorder route's real attack surface. Authorising the VENDOR is not
 * enough: a caller who owns vendor A could otherwise send A's id with a list
 * containing one of vendor B's photo ids, and the UPDATE would happily
 * renumber B's photo. Pure set logic, so it is tested directly.
 */
export function assertPhotosBelongTo(
  photoIds: readonly string[],
  ownedIds: readonly string[]
): { ok: true } | { ok: false; foreign: string[] } {
  const owned = new Set(ownedIds);
  const foreign = photoIds.filter((id) => !owned.has(id));
  return foreign.length === 0 ? { ok: true } : { ok: false, foreign };
}

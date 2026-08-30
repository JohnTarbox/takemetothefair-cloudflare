export const dynamic = "force-dynamic";
/**
 * OPE-211 increments 2b + 3 — list a vendor's gallery for the manager UI.
 *
 * Authorised through the SAME `authorizeVendorGallery` the mutating routes
 * use, so the read and the write agree on who owns what. A looser read would
 * let any logged-in user enumerate another vendor's photo ids, which is
 * precisely the input the reorder route's cross-tenant guard defends against
 * — no reason to hand it out.
 *
 * Returns legacy `gallery_images` entries too, flagged `isLegacy`, so the
 * manager can show them read-only rather than appearing to have lost them.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors } from "@/lib/db/schema";
import { authorizeVendorGallery } from "@/lib/vendor-photo-auth";
import { getVendorGallery } from "@/lib/vendor-photos";

export async function GET(request: Request) {
  const vendorId = new URL(request.url).searchParams.get("vendorId");
  if (!vendorId) {
    return NextResponse.json({ error: "vendorId is required" }, { status: 400 });
  }

  const session = await auth();
  const db = getCloudflareDb();

  const gate = await authorizeVendorGallery(db, vendorId, session?.user?.id, session?.user?.role);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const row = await db
    .select({ galleryImages: vendors.galleryImages })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);

  const photos = await getVendorGallery(db, vendorId, row[0]?.galleryImages);
  return NextResponse.json({ photos });
}

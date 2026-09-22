/**
 * OPE-211 increment 2 — the READ path for `vendor_photos`.
 *
 * ── Increment 1 shipped a write-only table ────────────────────────────────
 *
 * PR #740 created `vendor_photos` and taught the upload pipeline to append to
 * it. Nothing ever read it. Measured on prod 2026-08-30: **0 rows**, and no
 * code path anywhere selects from the table. So the feature was complete
 * end-to-end except for the end — the exact "shipped but silently not
 * executing" shape this project keeps hitting, in its quietest form: the code
 * is correct, deployed, and unreachable.
 *
 * ── …and increment 2 was then hidden behind a tier (OPE-1111) ─────────────
 *
 * This reader has been correct since 2026-08-30. The page called it, got the
 * photos, and then rendered them inside `{isEnhanced && …}` — so for another
 * 23 days every photo was fetched and thrown away. Prod on 2026-09-22: 72
 * photos, 26 vendors, **zero** of them enhanced, against 2 enhanced vendors
 * site-wide. A reader that works is not a feature that ships; the call site
 * decides that, and nothing was watching the call site.
 *
 * ── The legacy column must keep rendering ─────────────────────────────────
 *
 * `vendors.gallery_images` is a JSON array of `{url, alt, caption?}` and is
 * still the only place a vendor gallery exists for some rows. Migrating those
 * into `vendor_photos` is increment 4, which John explicitly did NOT approve —
 * "bulk backfill … needs its own STOP-gate".
 *
 * So this reader prefers the table and falls back to the JSON column, per
 * vendor. That is not a transitional hack to be cleaned up later; it is what
 * lets the new surface ship without a data mutation nobody authorised. When
 * the backfill is approved, the fallback stops being reached on its own — no
 * second change needed, and no flag day.
 *
 * ── Where the logic lives ─────────────────────────────────────────────────
 *
 * Everything downstream of the rows (legacy parse, featured-first ordering,
 * table-vs-legacy choice) moved to `@takemetothefair/utils` in OPE-1111 so
 * `get_vendor_details` shares it rather than growing a second copy. The names
 * are re-exported here unchanged, so existing imports and their tests are
 * untouched.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { vendorPhotos } from "@/lib/db/schema";
import { rotationCdnOption } from "@takemetothefair/db-schema";
import { resolveVendorGallery, type VendorGalleryPhoto } from "@takemetothefair/utils";

export {
  parseLegacyGallery,
  orderGalleryPhotos,
  resolveVendorGallery,
  type VendorGalleryPhoto,
} from "@takemetothefair/utils";

type Db = DrizzleD1Database<typeof schema>;

/**
 * Every gallery photo for a vendor, table-first with a legacy fallback.
 *
 * Not tier-aware, and must not become so — see the OPE-1111 note above.
 */
export async function getVendorGallery(
  db: Db,
  vendorId: string,
  legacyGalleryJson: string | null | undefined
): Promise<VendorGalleryPhoto[]> {
  const rows = await db
    .select({
      id: vendorPhotos.id,
      url: vendorPhotos.photoUrl,
      alt: vendorPhotos.altText,
      caption: vendorPhotos.caption,
      isFeatured: vendorPhotos.isFeatured,
      rotation: vendorPhotos.rotation,
    })
    .from(vendorPhotos)
    // OPE-686 — tombstones stay in the table; see event-photos.ts.
    .where(and(eq(vendorPhotos.vendorId, vendorId), isNull(vendorPhotos.deletedAt)))
    .orderBy(asc(vendorPhotos.sortOrder));

  return resolveVendorGallery(
    rows.map((r) => ({
      id: r.id,
      url: r.url,
      alt: r.alt ?? "",
      caption: r.caption ?? undefined,
      isFeatured: !!r.isFeatured,
      isLegacy: false,
      rotation: rotationCdnOption(r.rotation),
    })),
    legacyGalleryJson
  );
}

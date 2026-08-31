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
 * ── The legacy column must keep rendering ─────────────────────────────────
 *
 * `vendors.gallery_images` is a JSON array of `{url, alt, caption?}` and is
 * still the only place a vendor gallery exists in prod (1 vendor has one).
 * Migrating those rows into `vendor_photos` is increment 4, which John
 * explicitly did NOT approve — "bulk backfill … needs its own STOP-gate".
 *
 * So this reader prefers the table and falls back to the JSON column, per
 * vendor. That is not a transitional hack to be cleaned up later; it is what
 * lets the new surface ship without a data mutation nobody authorised. When
 * the backfill is approved, the fallback stops being reached on its own — no
 * second change needed, and no flag day.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { vendorPhotos } from "@/lib/db/schema";
import { rotationCdnOption } from "@takemetothefair/db-schema";

type Db = DrizzleD1Database<typeof schema>;

export interface VendorGalleryPhoto {
  /** `vendor_photos.id`, or null for a legacy JSON entry (which has no id). */
  id: string | null;
  url: string;
  alt: string;
  caption?: string;
  isFeatured: boolean;
  /** True when this came from the legacy column — the UI cannot edit it. */
  isLegacy: boolean;
  /** OPE-686 — render-time rotation; undefined when upright. See event-photos.ts. */
  rotation?: 90 | 180 | 270;
}

/**
 * Parse the legacy `vendors.gallery_images` JSON.
 *
 * Exported for tests, and separate from the query because malformed JSON is a
 * real state in this column — the previous reader swallowed it with a bare
 * catch and rendered nothing, which is right, but untested.
 */
export function parseLegacyGallery(raw: string | null | undefined): VendorGalleryPhoto[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (e): e is { url: string; alt?: string; caption?: string } =>
        typeof e === "object" && e !== null && typeof (e as { url?: unknown }).url === "string"
    )
    .map((e) => ({
      id: null,
      url: e.url,
      alt: typeof e.alt === "string" ? e.alt : "",
      caption: typeof e.caption === "string" ? e.caption : undefined,
      isFeatured: false,
      isLegacy: true,
    }));
}

/**
 * Order photos for display: featured first, then by `sort_order`, then by a
 * stable tiebreak.
 *
 * Pure and exported so the ordering is testable without a database — the
 * property that matters (a featured photo leads) is easy to lose in an
 * ORDER BY and impossible to notice by eye with two photos.
 */
export function orderGalleryPhotos(photos: VendorGalleryPhoto[]): VendorGalleryPhoto[] {
  return [...photos].sort((a, b) => {
    if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
    return 0;
  });
}

/**
 * Every gallery photo for a vendor, table-first with a legacy fallback.
 *
 * The fallback is per-vendor and all-or-nothing: a vendor with even one
 * `vendor_photos` row is considered migrated, and its legacy JSON is ignored.
 * Merging the two would double-render any photo the backfill later copies
 * across, and a duplicate photo is worse than an un-migrated one.
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

  if (rows.length === 0) return orderGalleryPhotos(parseLegacyGallery(legacyGalleryJson));

  return orderGalleryPhotos(
    rows.map((r) => ({
      id: r.id,
      url: r.url,
      alt: r.alt ?? "",
      caption: r.caption ?? undefined,
      isFeatured: !!r.isFeatured,
      isLegacy: false,
      rotation: rotationCdnOption(r.rotation),
    }))
  );
}

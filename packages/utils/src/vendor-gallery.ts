/**
 * Vendor gallery — the pure half, shared by the web page and the MCP reader.
 *
 * OPE-1111 moved these out of `src/lib/vendor-photos.ts`. They were app-only,
 * so when `get_vendor_details` gained a gallery it would have needed its own
 * copy of the legacy-JSON parse and the featured-first ordering — two
 * implementations of "what is in this vendor's gallery", free to disagree.
 *
 * That is not hypothetical here. The defect this package split came out of was
 * a gallery that rendered on one surface and not another for 23 days, and the
 * reason nobody caught it was that the public reader had no opinion about
 * galleries at all. Giving it one is the fix; giving it a SECOND opinion would
 * be the next bug.
 *
 * The query itself stays per-surface — each has its own Drizzle client and
 * table binding — but everything downstream of the rows is here.
 */

export interface VendorGalleryPhoto {
  /** `vendor_photos.id`, or null for a legacy JSON entry (which has no id). */
  id: string | null;
  url: string;
  alt: string;
  caption?: string;
  isFeatured: boolean;
  /** True when this came from the legacy column — the UI cannot edit it. */
  isLegacy: boolean;
  /** OPE-686 — render-time rotation; undefined when upright. */
  rotation?: 90 | 180 | 270;
}

/**
 * Parse the legacy `vendors.gallery_images` JSON.
 *
 * Exported separately from the query because malformed JSON is a real state in
 * this column — the pre-OPE-211 reader swallowed it with a bare catch and
 * rendered nothing, which is right, but was untested.
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
 * Order photos for display: featured first, then whatever order the caller
 * supplied (the query sorts by `sort_order`).
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
 * Choose between the `vendor_photos` rows and the legacy JSON column.
 *
 * All-or-nothing per vendor: a vendor with even one `vendor_photos` row is
 * considered migrated and its legacy JSON is ignored. Merging the two would
 * double-render any photo the (still-unapproved) backfill later copies across,
 * and a duplicate photo is worse than an un-migrated one.
 *
 * Note what is NOT here: any notion of vendor tier. The gallery used to render
 * only for Enhanced Profile vendors, which suppressed 100% of uploaded photos
 * — 72 of them, across 26 makers, none of whom were enhanced. Visibility is a
 * function of "are there photos", nothing else.
 */
export function resolveVendorGallery(
  tableRows: VendorGalleryPhoto[],
  legacyGalleryJson: string | null | undefined
): VendorGalleryPhoto[] {
  if (tableRows.length === 0) return orderGalleryPhotos(parseLegacyGallery(legacyGalleryJson));
  return orderGalleryPhotos(tableRows);
}

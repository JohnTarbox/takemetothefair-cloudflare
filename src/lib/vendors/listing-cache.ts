/**
 * OPE-1573 — cached, URL-independent reads for the /vendors listing.
 *
 * On 2026-11-05 09:02Z a crawler walking `/vendors?type=…` facet URLs drove
 * D1 into "overloaded": each force-dynamic render ran three full ~13.6K-row
 * vendor scans (D1 GraphQL d1QueriesAdaptiveGroups, 08:58–09:03Z: 17.3M of
 * 19.1M rows read). Two of the three do not depend on the URL at all:
 *
 *   - the vendor-type list (`SELECT DISTINCT vendor_type`), and
 *   - the Enhanced-Profile featured set — which DOES take `?type=`, but the
 *     whole set is tiny (2 rows on prod, 2026-11-06), so it is cached ONCE and
 *     filtered in memory. Caching per type would mint one KV key per facet
 *     value (~1,100 distinct vendor_type values) — exactly the URL space the
 *     crawler enumerates.
 *
 * TTL ≈ 1h, per John's ruling on OPE-1573. A vendor edit (new type, Enhanced
 * Profile granted) shows on /vendors within the hour.
 */
export const VENDOR_LISTING_CACHE_TTL_SECONDS = 3600;

/** Bump the `:vN` suffix when the cached value's SHAPE changes. */
export const VENDOR_TYPES_CACHE_KEY = "cache:vendors:types:v1";
export const FEATURED_VENDORS_CACHE_KEY = "cache:vendors:featured:v1";

/**
 * Same predicate the SQL used (`vendor_type = ?`, SQLite BINARY collation —
 * exact, case-sensitive match), applied to the cached full set.
 */
export function filterFeaturedByType<T extends { vendorType: string | null }>(
  all: T[],
  typeFilter: string | undefined
): T[] {
  if (!typeFilter) return all;
  return all.filter((v) => v.vendorType === typeFilter);
}

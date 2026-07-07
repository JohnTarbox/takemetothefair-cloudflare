/**
 * Blog cluster taxonomy (OPE-96 scorecard rollup) — OPE-101 canonical map.
 *
 * Replaces the v1 slug/tag KEYWORD HEURISTIC with an explicit, hand-authored
 * `slug → clusterId` map (analyst design doc Blog-Clusters-Canonical-Map-Design-
 * 2026-07-04.md §4). Rationale: the heuristic mis-bucketed edge posts by rule
 * order ("Craft Fairs in Maine" landed in a fair bucket, not craft-fairs) and
 * counted the one DRAFT (114 vs 113). An explicit map is mutually exclusive +
 * exhaustive over the 113 PUBLISHED posts, with a visible `unclustered` fallback
 * so a new/unmapped post is obvious rather than silently mis-filed.
 *
 * - `getCluster(slug)` → the mapped `ClusterId`, or `"unclustered"`.
 * - `CLUSTER_LABELS` keeps display labels SEPARATE from the stable kebab ids, so
 *   relabeling never touches the map.
 * - Drafts are excluded from the rollup upstream (blog-coverage.ts filters to
 *   PUBLISHED); the map itself only contains published slugs.
 *
 * Build guard: `blog-clusters.test.ts` fails if the map drifts from the 113-post
 * shape (count / per-cluster totals / invalid ids). A live "every PUBLISHED post
 * is in the map" check needs prod D1 (not available in CI) — the runtime signal
 * is the `unclustered` bucket surfacing on /admin/blog for any unmapped post.
 */

/** Stable kebab cluster ids (design §3) + the visible fallback. */
export type ClusterId =
  | "state-pillars"
  | "craft-fairs"
  | "breweries"
  | "gun-shows"
  | "big-e"
  | "renaissance"
  | "highland-games"
  | "food-festivals"
  | "boat-marine"
  | "individual-fairs"
  | "vendor-resources"
  | "visitor-tips"
  | "unclustered";

/** Display labels — separate from ids so rewording never touches the map (§3). */
export const CLUSTER_LABELS: Record<ClusterId, string> = {
  "state-pillars": "State fair & festival guides",
  "craft-fairs": "Craft fairs & art festivals",
  breweries: "Breweries & beer",
  "gun-shows": "Gun shows",
  "big-e": "The Big E",
  renaissance: "Renaissance faires",
  "highland-games": "Scottish & Highland games",
  "food-festivals": "Food & drink festivals",
  "boat-marine": "Boat & marine shows",
  "individual-fairs": "Individual fair guides",
  "vendor-resources": "Vendor resources & Maine Made",
  "visitor-tips": "Visitor tips & other events",
  unclustered: "Unclustered",
};

export const UNCLUSTERED: ClusterId = "unclustered";

/**
 * Canonical slug → clusterId map (design §4). Grouped by cluster; the per-group
 * counts are asserted in the test. 113 published posts, mutually exclusive.
 */
export const SLUG_TO_CLUSTER: Record<string, ClusterId> = {
  // ── state-pillars (7) ──
  "connecticut-fairs-and-festivals-2026-your-complete-guide": "state-pillars",
  "massachusetts-fairs-and-festivals-in-2026-your-complete-guide": "state-pillars",
  "rhode-island-fairs-and-festivals-2026-your-complete-guide": "state-pillars",
  "your-complete-guide-to-maine-fairs-and-festivals-in-2026": "state-pillars",
  "your-guide-to-new-hampshire-fairs-and-festivals-in-2026": "state-pillars",
  "vermont-agricultural-fairs-2026-your-guide-to-the-best-fairs-in-the-green-mountain-state":
    "state-pillars",
  "new-england-fair-season-2026-your-guide-to-the-best-fairs-festivals-and-shows": "state-pillars",

  // ── craft-fairs (20) ──
  "augusta-civic-center-holiday-craft-show-series-2026": "craft-fairs",
  "bar-harbor-craft-fair-circuit-2026-vendors-and-visitors-guide": "craft-fairs",
  "boston-metro-craft-fair-circuit-2026": "craft-fairs",
  "burlington-south-end-art-hop-2026-visitors-guide": "craft-fairs",
  "cape-cod-and-berkshires-craft-fair-circuit-2026-complete-regional-guide": "craft-fairs",
  "caravan-markets-the-curated-maine-craft-fair-series": "craft-fairs",
  "castleberry-fairs-nh-circuit-2026": "craft-fairs",
  "craft-fairs-in-maine-2026-a-vendors-and-visitors-guide": "craft-fairs",
  "craft-fairs-in-massachusetts-2026-a-vendors-and-visitors-guide": "craft-fairs",
  "craft-fairs-in-new-hampshire-2026-a-vendors-and-visitors-guide": "craft-fairs",
  "craft-fairs-in-vermont-2026-a-vendors-and-visitors-guide": "craft-fairs",
  "lakes-region-and-gunstock-craft-fairs-2026": "craft-fairs",
  "laudholm-nature-crafts-festival-2026-visitors-guide": "craft-fairs",
  "league-of-nh-craftsmen-fair-2026-visitors-and-vendors-guide": "craft-fairs",
  "mt-washington-valley-craft-fair-circuit-2026": "craft-fairs",
  "mystic-outdoor-art-festival-2026-visitors-guide": "craft-fairs",
  "old-deerfield-craft-fairs-vendors-and-visitors-guide": "craft-fairs",
  "paradise-city-arts-festival-vendors-and-visitors-guide": "craft-fairs",
  "quechee-hot-air-balloon-and-craft-festival-2026-visitors-guide": "craft-fairs",
  "stowe-foliage-arts-festival-2026-visitors-guide": "craft-fairs",

  // ── breweries (9) ──
  "connecticut-breweries-2026-67-craft-brewers-from-stratford-to-the-quiet-corner": "breweries",
  "maine-breweries-2026-a-complete-guide-to-portland-and-beyond": "breweries",
  "massachusetts-breweries-2026-a-region-by-region-guide-to-all-197": "breweries",
  "new-england-breweries-2026-the-complete-guide-to-500-craft-brewers": "breweries",
  "new-hampshire-breweries-2026-75-brewers-from-the-seacoast-to-the-north-country": "breweries",
  "vermont-breweries-2026-hill-farmstead-heady-topper-and-the-states-59-breweries": "breweries",
  "new-england-beer-festivals-2026-a-month-by-month-calendar": "breweries",
  "new-hampshire-beer-trail-and-festival-2026-a-complete-guide": "breweries",
  "vermont-brewers-festival-2026-30th-annual-visitors-guide": "breweries",

  // ── gun-shows (6) ──
  "collecting-vintage-firearms-at-new-england-gun-shows": "gun-shows",
  "first-time-gun-show-buyers-guide-what-to-know-before-you-buy": "gun-shows",
  "gun-shows-in-maine-2026-the-complete-schedule-and-guide": "gun-shows",
  "gun-shows-in-new-england-2026-your-complete-schedule-and-guide": "gun-shows",
  "vermont-gun-shows-in-2026-what-to-expect-and-where-to-find-them": "gun-shows",
  "what-to-bring-to-a-gun-show-a-checklist-for-buyers-and-sellers": "gun-shows",

  // ── big-e (6) ──
  "best-food-at-the-big-e-what-to-eat-and-whats-worth-the-line": "big-e",
  "big-e-on-a-budget-how-to-enjoy-the-fair-without-breaking-the-bank": "big-e",
  "big-e-parking-and-getting-there-how-to-avoid-the-stress": "big-e",
  "the-big-e-avenue-of-states-a-building-by-building-guide": "big-e",
  "the-big-e-with-kids-a-family-guide-to-the-eastern-states-exposition": "big-e",
  "the-big-e-your-guide-to-the-eastern-states-exposition-in-2026": "big-e",

  // ── renaissance (6) ──
  "connecticut-renaissance-faire-2026-visitors-guide": "renaissance",
  "king-richards-faire-2026-visitors-guide": "renaissance",
  "maine-renaissance-faire-2026-visitors-guide": "renaissance",
  "midsummer-fantasy-renaissance-faire-2026-visitors-guide": "renaissance",
  "new-england-renaissance-faires-2026-a-complete-guide": "renaissance",
  "vermont-renaissance-faire-2026-visitors-guide": "renaissance",

  // ── highland-games (4) ──
  "glasgow-lands-scottish-festival-2026-visitors-guide": "highland-games",
  "maine-highland-games-and-scottish-festival-2026-visitors-guide": "highland-games",
  "new-england-scottish-and-highland-games-2026-a-complete-guide": "highland-games",
  "new-hampshire-highland-games-and-festival-2026-visitors-guide": "highland-games",

  // ── food-festivals (14) ──
  "machias-wild-blueberry-festival-2026-visitors-guide": "food-festivals",
  "maine-food-and-drink-festivals-2026-a-complete-guide": "food-festivals",
  "maine-lobster-festival-2026-visitors-guide": "food-festivals",
  "maine-oyster-festival-2026-visitors-guide": "food-festivals",
  "maine-whoopie-pie-festival-2026-visitors-guide": "food-festivals",
  "moxie-festival-2026-visitors-guide": "food-festivals",
  "new-england-fair-food-bucket-list-what-you-have-to-try": "food-festivals",
  "new-england-seafood-festivals-2026-lobster-oyster-clam-and-chowder-guide": "food-festivals",
  "new-england-strawberry-festivals-2026-a-complete-guide": "food-festivals",
  "north-stonington-strawberry-festival-2026-visitors-guide": "food-festivals",
  "the-best-fair-food-in-maine-what-to-eat-at-every-fair": "food-festivals",
  "vermont-maple-products-at-fairs-a-tasting-guide-for-visitors": "food-festivals",
  "wellfleet-oysterfest-2026-visitors-guide": "food-festivals",
  "yarmouth-clam-festival-2026-visitors-guide": "food-festivals",

  // ── boat-marine (7) ──
  "maine-boat-and-home-show-in-rockland-new-englands-premier-in-water-boat-show": "boat-marine",
  "maines-best-sailing-regattas-a-guide-to-the-midcoast-racing-season": "boat-marine",
  "newport-international-boat-show-2026-visitors-guide": "boat-marine",
  "norwalk-boat-show-2026-visitors-guide": "boat-marine",
  "the-best-shows-in-maine-for-boat-owners-and-sailors": "boat-marine",
  "the-portland-boat-show-maines-biggest-indoor-boat-show": "boat-marine",
  "windjammer-days-in-boothbay-harbor-a-week-of-tall-ships-and-tradition": "boat-marine",

  // ── individual-fairs (12) ──
  "barnstable-county-fair-2026-visitors-guide": "individual-fairs",
  "belchertown-fair-2026-a-visitors-guide-to-one-of-massachusetts-best-small-fairs":
    "individual-fairs",
  "cummington-fair-2026-visitors-guide": "individual-fairs",
  "deerfield-fair-2026-a-visitors-guide-to-new-hampshires-most-beloved-fair": "individual-fairs",
  "durham-fair-2026-visitors-guide-to-connecticuts-largest-fair": "individual-fairs",
  "fryeburg-fair-2026-everything-you-need-to-know-before-you-go": "individual-fairs",
  "hebron-harvest-fair-2026-visitors-guide": "individual-fairs",
  "new-hampshire-sheep-and-wool-festival-a-guide-for-fiber-enthusiasts": "individual-fairs",
  "the-common-ground-country-fair-maines-most-unique-fair-experience": "individual-fairs",
  "the-sandwich-fair-why-this-no-frills-nh-fair-is-a-local-favorite": "individual-fairs",
  "tunbridge-worlds-fair-vermonts-most-storied-agricultural-fair": "individual-fairs",
  "vermont-sheep-and-wool-festival-2026-visitors-guide": "individual-fairs",

  // ── vendor-resources (11) ──
  "best-payment-apps-for-craft-fair-vendors-in-2026": "vendor-resources",
  "craft-fair-booth-display-ideas-that-actually-increase-sales": "vendor-resources",
  "do-craft-fair-vendors-need-insurance-what-to-know-before-your-first-fair": "vendor-resources",
  "how-many-items-should-you-bring-to-a-craft-fair-a-simple-formula": "vendor-resources",
  "how-to-build-an-email-list-at-craft-fairs-and-why-it-matters-more-than-the-sale":
    "vendor-resources",
  "so-you-want-to-be-a-craft-fair-vendor-a-beginners-guide-to-getting-started-in-new-england":
    "vendor-resources",
  "how-maine-made-helps-craft-fair-vendors-stand-out-at-events": "vendor-resources",
  "how-to-apply-for-maine-made-membership-requirements-and-what-to-expect": "vendor-resources",
  "maine-made-certified-retailers-how-to-get-your-products-on-store-shelves": "vendor-resources",
  "maine-made-trade-show-grants-how-to-get-up-to-dollar5000-per-show": "vendor-resources",
  "the-maine-made-program-a-complete-guide-for-artisans-makers-and-small-businesses":
    "vendor-resources",

  // ── visitor-tips (11) ──
  "best-new-england-fairs-for-families-with-kids": "visitor-tips",
  "bristol-4th-of-july-parade-2026-250th-anniversary-visitors-guide": "visitor-tips",
  "craft-fairs-vs-agricultural-fairs-in-new-england-whats-the-difference": "visitor-tips",
  "hartford-home-show-2026-what-to-expect": "visitor-tips",
  "how-to-plan-a-new-england-fair-season-road-trip": "visitor-tips",
  "newport-folk-festival-2026-visitors-guide": "visitor-tips",
  "rv-shows-in-new-england-2026-where-to-shop-compare-and-dream": "visitor-tips",
  "taking-kids-to-a-maine-fair-a-family-planning-guide": "visitor-tips",
  "vermont-fall-foliage-and-fairs-how-to-combine-the-best-of-both": "visitor-tips",
  "waterfire-providence-complete-guide": "visitor-tips",
  "what-to-wear-to-a-new-england-fair-a-seasonal-guide": "visitor-tips",
};

/** The mapped cluster id for a slug, or `"unclustered"` when unmapped. Pure. */
export function getCluster(slug: string): ClusterId {
  return SLUG_TO_CLUSTER[slug] ?? UNCLUSTERED;
}

/** The display label for a slug's cluster (via getCluster). Pure. */
export function getClusterLabel(slug: string): string {
  return CLUSTER_LABELS[getCluster(slug)];
}

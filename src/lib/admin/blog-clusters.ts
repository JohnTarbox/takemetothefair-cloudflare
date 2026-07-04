/**
 * Blog cluster classifier (OPE-96) — collapses the ~113-post blog corpus into
 * ~13 topic buckets so the /admin/blog scorecard can roll up effectiveness by
 * theme instead of one row at a time.
 *
 * Why heuristic, not a column: `blog_posts.categories` is useless for
 * clustering (112 of 113 posts are just "Guides") and `tags` overlap. The
 * design brief's v1 is a slug/tag → cluster map. This is the formalization of
 * that map: a single editable, precedence-ordered table (`CLUSTER_RULES`) so
 * the taxonomy can be tuned in one place. First matching rule wins, so rules
 * are ordered MOST-SPECIFIC FIRST (e.g. "the-big-e" before generic fair
 * matching; "craft-fair" before the broad "fair" match). Anything unmatched
 * falls through to "Other / general".
 *
 * If the brief ever promotes this to a real `cluster` field on blog_posts,
 * this stays the backfill source of truth.
 */

/** The 13 v1 buckets (design brief §4). Exported for reuse in the UI/rollup. */
export const BLOG_CLUSTERS = [
  "Gun shows",
  "State fair/festival guides",
  "Craft fairs",
  "Breweries & beer",
  "Food festivals",
  "Single-event guides",
  "Renaissance faires",
  "Boat & marine",
  "The Big E",
  "Scottish & Highland",
  "Maine Made program",
  "Vendor how-to",
  "Other / general",
] as const;

export type BlogCluster = (typeof BLOG_CLUSTERS)[number];

/** Fallback bucket when no rule matches. */
export const DEFAULT_CLUSTER: BlogCluster = "Other / general";

interface ClusterRule {
  cluster: BlogCluster;
  /** Substrings matched against the lowercased slug. */
  slugIncludes: string[];
  /** Substrings matched against each lowercased tag. */
  tagIncludes: string[];
}

/**
 * Ordered MOST-SPECIFIC → LEAST. First hit wins. Edit here to tune the
 * taxonomy. Keep proper-noun / single-topic buckets ahead of the broad
 * "fair"/"guide" buckets so those don't swallow a more precise match.
 */
export const CLUSTER_RULES: ClusterRule[] = [
  // Proper-noun single venue — must precede the generic fair buckets.
  {
    cluster: "The Big E",
    slugIncludes: ["the-big-e", "big-e"],
    tagIncludes: ["the big e", "big e", "eastern states exposition"],
  },
  {
    cluster: "Gun shows",
    slugIncludes: ["gun-show", "gun-shows"],
    tagIncludes: ["gun show", "gun shows", "guns"],
  },
  {
    cluster: "Scottish & Highland",
    slugIncludes: ["scottish", "highland", "celtic", "tartan", "bagpipe"],
    tagIncludes: ["scottish", "highland games", "highland", "celtic"],
  },
  {
    cluster: "Maine Made program",
    slugIncludes: ["maine-made"],
    tagIncludes: ["maine made", "maine made program"],
  },
  {
    cluster: "Renaissance faires",
    slugIncludes: ["renaissance", "ren-faire", "renfaire", "ren-fair", "king-richards", "-faire"],
    tagIncludes: ["renaissance", "renaissance faire", "renaissance fair"],
  },
  {
    cluster: "Boat & marine",
    slugIncludes: ["boat", "marine", "yacht", "sailing", "nautical", "maritime", "rv-show"],
    tagIncludes: ["boat show", "boat", "marine", "maritime", "nautical"],
  },
  {
    cluster: "Breweries & beer",
    slugIncludes: ["brewery", "breweries", "brewers", "brewfest", "brewing", "beer", "cider"],
    tagIncludes: ["brewery", "breweries", "beer", "brewers", "brewfest", "cider"],
  },
  // Food festivals BEFORE the generic fair/festival bucket — a "moxie-festival" or
  // "maine-oyster-festival" is food, not a state fair. Word-list is deliberately
  // broad (specific foods + "food"/"fair-food") so the topical "X festival" posts
  // land here instead of the catch-all below.
  {
    cluster: "Food festivals",
    slugIncludes: [
      "food-festival",
      "food-fest",
      "food-and-drink",
      "fair-food",
      "food-bucket",
      "clam",
      "lobster",
      "oyster",
      "chowder",
      "seafood",
      "strawberry",
      "blueberry",
      "whoopie-pie",
      "moxie",
      "maple",
      "chili",
      "garlic",
      "pumpkin",
      "apple-festival",
      "harvest-festival",
      "chocolate",
    ],
    tagIncludes: ["food festival", "food festivals", "food", "seafood festival"],
  },
  // Craft/art fairs BEFORE the state-fair bucket so "outdoor-art-festival",
  // "sheep-and-wool", "art-hop", "craft-fair(s)" don't get grabbed by the broad
  // "fair"/"festival" match below.
  {
    cluster: "Craft fairs",
    slugIncludes: [
      "craft-fair",
      "craft-fairs",
      "craft-show",
      "crafts",
      "craft-festival",
      "artisan",
      "handmade",
      "art-festival",
      "arts-festival",
      "outdoor-art",
      "foliage-arts",
      "art-hop",
      "sheep-and-wool",
      "wool",
      "quilt",
    ],
    tagIncludes: [
      "craft fair",
      "craft fairs",
      "craft show",
      "crafts",
      "artisan",
      "handmade",
      "art",
    ],
  },
  {
    cluster: "Vendor how-to",
    slugIncludes: ["how-to", "sell-at", "become-a-vendor", "vendor-tips", "vendor-guide", "booth"],
    tagIncludes: ["vendor tips", "how to", "vendor how-to", "selling"],
  },
  // Broad state/agricultural/county fair guides — AFTER the specific topical
  // buckets. NOTE (OPE-96): §5 is the analyst's SEMANTIC grouping; the heuristic
  // can't perfectly reproduce it (many non-fair posts contain "fair"/"festival"
  // in the slug — see the reconciliation caveat). "festival" is intentionally
  // dropped here so topical "X festival" posts fall to Single-event/Other, not
  // this bucket. Tune this list (or supply a canonical slug→cluster map) to match.
  {
    cluster: "State fair/festival guides",
    slugIncludes: [
      "state-fair",
      "county-fair",
      "agricultural-fair",
      "worlds-fair",
      "country-fair",
      "harvest-fair",
      "fair-season",
      "fairs-and-festivals",
      "-fair-2026",
      "-fair-",
    ],
    tagIncludes: ["state fair", "county fair", "agricultural fair"],
  },
  // Catch-all for the remaining "guide to <single event>" posts. Broad on
  // purpose and evaluated last before the default so topical buckets win first.
  {
    cluster: "Single-event guides",
    slugIncludes: ["guide-to", "guide"],
    tagIncludes: ["event guide", "single event", "guide"],
  },
];

function matchesRule(rule: ClusterRule, slug: string, tags: string[]): boolean {
  if (rule.slugIncludes.some((needle) => slug.includes(needle))) return true;
  return tags.some((tag) => rule.tagIncludes.some((needle) => tag.includes(needle)));
}

/**
 * Classify a post into one of the 13 v1 clusters. Pure — same inputs always
 * return the same bucket. First matching rule (most-specific first) wins;
 * unmatched posts return "Other / general".
 */
export function classifyCluster(input: { slug: string; tags: string[] }): BlogCluster {
  const slug = input.slug.toLowerCase();
  const tags = input.tags.map((t) => t.toLowerCase());
  for (const rule of CLUSTER_RULES) {
    if (matchesRule(rule, slug, tags)) return rule.cluster;
  }
  return DEFAULT_CLUSTER;
}

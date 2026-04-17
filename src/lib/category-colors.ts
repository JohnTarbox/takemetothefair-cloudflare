/**
 * Category-based color mappings for event cards and detail pages.
 *
 * Five-palette system (Gold, Terracotta, Sage, Navy-soft, Stone-craft) —
 * categories in the same family share a tint so chips read as belonging
 * to a coherent group rather than 16 bespoke silos.
 */

type CategoryColors = {
  bg: string;
  icon: string;
  badge: string;
  accent: string;
};

const GOLD: CategoryColors = {
  bg: "bg-amber-light",
  icon: "text-amber",
  badge: "bg-amber-light text-amber-dark",
  accent: "#E8960C",
};

const TERRACOTTA: CategoryColors = {
  bg: "bg-terracotta-light",
  icon: "text-terracotta",
  badge: "bg-terracotta-light text-stone-900",
  accent: "#D97757",
};

const SAGE: CategoryColors = {
  bg: "bg-sage-50",
  icon: "text-sage-700",
  badge: "bg-sage-50 text-sage-700",
  accent: "#6B7E5E",
};

const NAVY_SOFT: CategoryColors = {
  bg: "bg-stone-100",
  icon: "text-navy",
  badge: "bg-stone-100 text-navy",
  accent: "#1E2761",
};

const STONE_CRAFT: CategoryColors = {
  bg: "bg-stone-50",
  icon: "text-stone-600",
  badge: "bg-stone-50 text-stone-900",
  accent: "#6F6455",
};

const CATEGORY_COLORS: Record<string, CategoryColors> = {
  Fair: GOLD,
  "Agricultural Fair": GOLD,
  Festival: TERRACOTTA,
  "Music Festival": TERRACOTTA,
  "Food Festival": TERRACOTTA,
  "Holiday Market": TERRACOTTA,
  "Farmers Market": SAGE,
  Market: SAGE,
  "Art Walk": SAGE,
  "Home Show": NAVY_SOFT,
  "Trade Show": NAVY_SOFT,
  "Car Show": NAVY_SOFT,
  "Craft Fair": STONE_CRAFT,
  "Craft Show": STONE_CRAFT,
  "Fiber Arts Festival": STONE_CRAFT,
  "Antique Show": STONE_CRAFT,
  "Flea Market": STONE_CRAFT,
  Other: STONE_CRAFT,
};

const DEFAULT_COLORS: CategoryColors = STONE_CRAFT;

/**
 * Get colors for the first matching category. Falls back to stone-craft neutral.
 */
export function getCategoryColors(categories: string[]): CategoryColors {
  for (const cat of categories) {
    if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  }
  return DEFAULT_COLORS;
}

/**
 * Get badge classes for a single category name.
 */
export function getCategoryBadgeClass(category: string): string {
  return CATEGORY_COLORS[category]?.badge ?? DEFAULT_COLORS.badge;
}

/**
 * Category-to-placeholder-image mapping. Groups categories into 6 themed SVGs.
 */
const CATEGORY_IMAGES: Record<string, string> = {
  "Agricultural Fair": "/images/categories/fair.svg",
  Fair: "/images/categories/fair.svg",
  Festival: "/images/categories/festival.svg",
  "Music Festival": "/images/categories/festival.svg",
  "Fiber Arts Festival": "/images/categories/festival.svg",
  "Craft Show": "/images/categories/craft.svg",
  "Craft Fair": "/images/categories/craft.svg",
  "Art Walk": "/images/categories/craft.svg",
  "Food Festival": "/images/categories/food.svg",
  "Farmers Market": "/images/categories/market.svg",
  Market: "/images/categories/market.svg",
  "Flea Market": "/images/categories/market.svg",
  "Holiday Market": "/images/categories/market.svg",
  "Antique Show": "/images/categories/market.svg",
  "Home Show": "/images/categories/other.svg",
  "Trade Show": "/images/categories/other.svg",
  "Car Show": "/images/categories/other.svg",
  Other: "/images/categories/other.svg",
};

const DEFAULT_IMAGE = "/images/categories/other.svg";

/**
 * Get a category-appropriate placeholder image path for events without images.
 */
export function getCategoryImage(categories: string[]): string {
  for (const cat of categories) {
    if (CATEGORY_IMAGES[cat]) return CATEGORY_IMAGES[cat];
  }
  return DEFAULT_IMAGE;
}

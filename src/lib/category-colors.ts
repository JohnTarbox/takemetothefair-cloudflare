/**
 * Category-based color mappings for event cards and detail pages.
 * Colors are chosen to visually differentiate event types at a glance.
 */

type CategoryColors = {
  bg: string;
  icon: string;
  badge: string;
};

const CATEGORY_COLORS: Record<string, CategoryColors> = {
  Fair: {
    bg: "bg-amber-light",
    icon: "text-amber",
    badge: "bg-amber-light text-amber",
  },
  Festival: {
    bg: "bg-brand-blue-light",
    icon: "text-royal",
    badge: "bg-brand-blue-light text-royal",
  },
  "Craft Show": {
    bg: "bg-purple-50",
    icon: "text-purple-400",
    badge: "bg-purple-100 text-purple-700",
  },
  "Craft Fair": {
    bg: "bg-purple-50",
    icon: "text-purple-400",
    badge: "bg-purple-100 text-purple-700",
  },
  Market: {
    bg: "bg-green-50",
    icon: "text-green-400",
    badge: "bg-green-100 text-green-700",
  },
  "Farmers Market": {
    bg: "bg-emerald-50",
    icon: "text-emerald-400",
    badge: "bg-emerald-100 text-emerald-700",
  },
  "Agricultural Fair": {
    bg: "bg-yellow-50",
    icon: "text-yellow-500",
    badge: "bg-yellow-100 text-yellow-700",
  },
  "Art Walk": {
    bg: "bg-rose-50",
    icon: "text-rose-400",
    badge: "bg-rose-100 text-rose-700",
  },
  "Flea Market": {
    bg: "bg-orange-50",
    icon: "text-orange-400",
    badge: "bg-orange-100 text-orange-700",
  },
  "Food Festival": {
    bg: "bg-red-50",
    icon: "text-red-400",
    badge: "bg-red-100 text-red-700",
  },
  "Holiday Market": {
    bg: "bg-teal-50",
    icon: "text-teal-400",
    badge: "bg-teal-100 text-teal-700",
  },
  "Home Show": {
    bg: "bg-slate-50",
    icon: "text-slate-400",
    badge: "bg-slate-100 text-slate-700",
  },
  "Music Festival": {
    bg: "bg-indigo-50",
    icon: "text-indigo-400",
    badge: "bg-indigo-100 text-indigo-700",
  },
  "Trade Show": {
    bg: "bg-cyan-50",
    icon: "text-cyan-400",
    badge: "bg-cyan-100 text-cyan-700",
  },
};

const DEFAULT_COLORS: CategoryColors = {
  bg: "bg-gray-100",
  icon: "text-gray-400",
  badge: "bg-gray-100 text-gray-700",
};

/**
 * Get colors for the first matching category. Falls back to neutral gray.
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
 * Category-to-placeholder-image mapping. Groups 16 categories into 6 themed SVGs.
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

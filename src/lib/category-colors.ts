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
    bg: "bg-blue-50",
    icon: "text-blue-400",
    badge: "bg-blue-100 text-blue-700",
  },
  Festival: {
    bg: "bg-purple-50",
    icon: "text-purple-400",
    badge: "bg-purple-100 text-purple-700",
  },
  "Craft Show": {
    bg: "bg-amber-50",
    icon: "text-amber-400",
    badge: "bg-amber-100 text-amber-700",
  },
  "Craft Fair": {
    bg: "bg-amber-50",
    icon: "text-amber-400",
    badge: "bg-amber-100 text-amber-700",
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

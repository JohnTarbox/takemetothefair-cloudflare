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

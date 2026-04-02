/**
 * State-based color mappings for venue cards.
 * Covers New England states; others fall back to neutral gray.
 */

type StateColors = {
  bg: string;
  icon: string;
  badge: string;
};

const STATE_COLORS: Record<string, StateColors> = {
  ME: {
    bg: "bg-blue-50",
    icon: "text-blue-400",
    badge: "bg-blue-100 text-blue-700",
  },
  MA: {
    bg: "bg-purple-50",
    icon: "text-purple-400",
    badge: "bg-purple-100 text-purple-700",
  },
  NH: {
    bg: "bg-amber-50",
    icon: "text-amber-400",
    badge: "bg-amber-100 text-amber-700",
  },
  VT: {
    bg: "bg-green-50",
    icon: "text-green-400",
    badge: "bg-green-100 text-green-700",
  },
  CT: {
    bg: "bg-rose-50",
    icon: "text-rose-400",
    badge: "bg-rose-100 text-rose-700",
  },
  RI: {
    bg: "bg-cyan-50",
    icon: "text-cyan-400",
    badge: "bg-cyan-100 text-cyan-700",
  },
};

const DEFAULT_COLORS: StateColors = {
  bg: "bg-gray-100",
  icon: "text-gray-400",
  badge: "bg-gray-100 text-gray-700",
};

export function getStateColors(state: string | null | undefined): StateColors {
  if (!state) return DEFAULT_COLORS;
  return STATE_COLORS[state.toUpperCase()] ?? DEFAULT_COLORS;
}

export function getStateBadgeClass(state: string | null | undefined): string {
  if (!state) return DEFAULT_COLORS.badge;
  return STATE_COLORS[state.toUpperCase()]?.badge ?? DEFAULT_COLORS.badge;
}

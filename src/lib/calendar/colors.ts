// CAL1 — category → color for the SSR Month calendar (@jonnyboats/calendar-react).
//
// The module's `theme.categoryColors` is a `Record<string, string>` of category →
// CSS color value (it drives the legend swatch, day dots, and ribbons via
// `data-category`). The legacy client calendar in `events-view.tsx` uses Tailwind
// *class names* (`bg-blue-500`) for the same palette; the module needs raw color
// values instead, so we keep the hex equivalents here.
//
// The hash is kept byte-for-byte identical to `paletteIndexForCategory` in
// `events-view.tsx` so a given category lands on the same palette slot in both the
// old and new calendars (consistent "Festival = blue" across the cutover). When the
// legacy Month renderer is retired, unify both representations here.

// Categorical viz palette escape hatch (per the no-restricted-syntax rule's own
// guidance + the documented exclusion of calendar/chart palettes from the design
// tokens): these are 8 distinct *category* hues, not semantic brand tokens, and the
// module's theme.categoryColors needs raw color VALUES (not Tailwind classes). They
// mirror the legacy calendar's Tailwind `*-500` family so colors match across the cutover.
/* eslint-disable no-restricted-syntax */
/** Hex equivalents of the Tailwind `*-500` palette used by the legacy calendar. */
export const CALENDAR_CATEGORY_PALETTE = [
  "#3b82f6", // blue-500
  "#22c55e", // green-500
  "#a855f7", // purple-500
  "#ec4899", // pink-500
  "#6366f1", // indigo-500
  "#14b8a6", // teal-500
  "#f97316", // orange-500
  "#06b6d4", // cyan-500
] as const;
/* eslint-enable no-restricted-syntax */

/** Stable category → palette index. MUST match `events-view.tsx`'s hash. */
export function paletteIndexForCategory(category: string): number {
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % CALENDAR_CATEGORY_PALETTE.length;
}

/** The color value for a single category. */
export function colorForCategory(category: string): string {
  return CALENDAR_CATEGORY_PALETTE[paletteIndexForCategory(category)]!;
}

/**
 * Build the `theme.categoryColors` map from the categories actually present in a
 * window of CalendarEvents — one entry per distinct category, so the legend only
 * lists what's on screen.
 */
export function categoryColorsForEvents(
  events: ReadonlyArray<{ category?: string | undefined }>
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of events) {
    if (e.category && !(e.category in map)) map[e.category] = colorForCategory(e.category);
  }
  return map;
}

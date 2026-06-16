// CAL2 — shared CalendarTheme builder. Maps the site's design tokens into the
// @jonnyboats calendar theme so every view (Month/Week/Day/Custom/Agenda/Year)
// matches the rest of the site instead of the module's generic defaults, giving
// it a clean Google-Calendar-like surface.
//
// Tokens are passed as `rgb(var(--token))` rather than hex: the module applies
// theme values as CSS custom properties on the calendar root, so var() resolves
// from :root and the calendar AUTO-ADAPTS to dark mode (the site tokens flip
// under `.dark`). categoryColors stay concrete hex (the module writes them as
// inline `style="background:#..."`, which can't be a var()).

import type { CalendarTheme } from "@jonnyboats/calendar-react";

export function buildCalendarTheme(categoryColors: Record<string, string>): CalendarTheme {
  return {
    bg: "rgb(var(--card))", // white surface (cream page → clean white calendar panel)
    fg: "rgb(var(--foreground))", // primary text
    muted: "rgb(var(--muted-foreground))", // hour labels, weekday headers
    border: "rgb(var(--border))", // gridlines
    today: "rgb(var(--ring))", // royal blue — today disc/column, like Google Calendar
    accent: "rgb(var(--ring))", // selection/now accent
    fontFamily: "inherit", // adopt the site's font stack
    categoryColors,
  };
}

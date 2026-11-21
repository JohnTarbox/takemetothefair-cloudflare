"use client";

// CAL1 — the thin client wrapper around the module's <MonthCalendar>.
//
// <MonthCalendar> is a client component and takes interactive callbacks
// (onNavigate, etc.) that cannot cross the RSC boundary as props. So the server
// component (calendar-ssr.tsx) does the D1 query + adapter and passes only
// SERIALIZABLE data in (events/now/anchor/theme); this wrapper owns the callbacks.
// `now` is host-pinned on the server and passed through unchanged, so server HTML
// and first client paint agree (no hydration mismatch).
//
// OPE-1488 — a date number (and the day popover's "View full day" and title) opens
// Day view for that date. Without `onNavigateToDay` the module fell back to the
// popover, and "View full day" only closed it. Month navigation writes the focus
// date so switching to Day/Week lands in the month being viewed, not on today.

import { useCallback, useRef } from "react";
import { MonthCalendar, type CalendarEvent, type CalendarTheme } from "@jonnyboats/calendar-react";
import "@jonnyboats/calendar-react/styles";
import { focusForMonth } from "@/lib/calendar/focus-date";
import { renderSortedDayPopover, useCalendarNav } from "./calendar-nav";
import { useCalendarDayLinks } from "./use-calendar-day-links";

interface Props {
  events: CalendarEvent[];
  /** Host-pinned ISO instant (SSR-stable "now"). */
  now: string;
  displayTimeZone: string;
  /** Mid-month DayKey of the visible month. */
  initialAnchor: string;
  theme: CalendarTheme;
  /** OPE-1488 — the focus date (`date=`), carried into the other views. */
  focusDate: string;
  /** Today on the America/New_York calendar. */
  today: string;
}

export function CalendarMonthClient({
  events,
  now,
  displayTimeZone,
  initialAnchor,
  theme,
  focusDate,
  today,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { pushFocus, navigateToDay, switchView } = useCalendarNav(focusDate);
  useCalendarDayLinks(rootRef, navigateToDay, switchView);

  // Visible period changed (next/prev/today/jump) → make the URL the source of
  // truth so back/forward + direct links work and the server re-renders the month.
  const onNavigate = useCallback(
    (next: { anchor: string; window: { start: string; end: string } }) => {
      const month = next.anchor.slice(0, 7); // "YYYY-MM"
      pushFocus(focusForMonth(month, today), "month");
    },
    [pushFocus, today]
  );

  // `cal-legend-left` drives a CSS-grid override (src/app/globals.css) that moves
  // the module's category legend into a left sidebar on >=768px. Month-only —
  // Agenda/Year share `.cm-root` but aren't wrapped, so they're unaffected.
  return (
    <div className="cal-legend-left" ref={rootRef}>
      <MonthCalendar
        events={events}
        now={now}
        displayTimeZone={displayTimeZone}
        initialAnchor={initialAnchor}
        theme={theme}
        weekStartsOn={0}
        locale="en-US"
        onNavigate={onNavigate}
        onNavigateToDay={navigateToDay}
        renderDayPopover={renderSortedDayPopover}
      />
    </div>
  );
}

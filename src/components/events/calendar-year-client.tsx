"use client";

// CAL2 — thin client wrapper around the module's <YearCalendar>.
//
// The server builds the cheap per-day presence map (calendar-year-ssr.tsx) and
// passes it in; this wrapper owns the navigation callbacks (URL is the source of
// truth, so back/forward + direct links work) and `hydrateDay`, which lazily fetches
// a single day's full events for the day popover when a dotted day is clicked.

import { useCallback, useRef } from "react";
import { YearCalendar, type CalendarEvent, type CalendarTheme } from "@jonnyboats/calendar-react";
import type { PresenceMap } from "@jonnyboats/calendar-core";
import "@jonnyboats/calendar-react/styles";
import { focusForMonth, focusForYear } from "@/lib/calendar/focus-date";
import { renderSortedDayPopover, useCalendarNav } from "./calendar-nav";
import { useCalendarDayLinks } from "./use-calendar-day-links";

interface Props {
  presence: PresenceMap;
  year: number;
  /** Host-pinned ISO instant (SSR-stable today-disc). */
  now: string;
  displayTimeZone: string;
  theme: CalendarTheme;
  /** OPE-1488 — the focus date (`date=`) and today (America/New_York). */
  focusDate: string;
  today: string;
}

export function CalendarYearClient({
  presence,
  year,
  now,
  displayTimeZone,
  theme,
  focusDate,
  today,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { pushFocus, navigateToDay, switchView } = useCalendarNav(focusDate);
  useCalendarDayLinks(rootRef, navigateToDay, switchView, { directYearCells: true });

  // Prev/next/Today → refetch presence for the new year (server re-renders).
  const onNavigateYear = useCallback(
    (y: number) => pushFocus(focusForYear(y, today), "year"),
    [pushFocus, today]
  );

  // Month title click → Month view anchored to that month.
  const onNavigateToMonth = useCallback(
    (monthAnchor: string) => pushFocus(focusForMonth(monthAnchor.slice(0, 7), today), "month"),
    [pushFocus, today]
  );

  // Dotted-day click → fetch that day's full events for the popover. Failure
  // degrades to an empty day (the module renders "no events"), never a throw.
  const hydrateDay = useCallback(async (date: string): Promise<CalendarEvent[]> => {
    try {
      const res = await fetch(`/api/events/calendar-day?date=${encodeURIComponent(date)}`);
      if (!res.ok) return [];
      return (await res.json()) as CalendarEvent[];
    } catch {
      return [];
    }
  }, []);

  // `cal-legend-left` moves the category legend into a left sidebar on >=768px
  // (CSS in src/app/globals.css) — same treatment as Month, so the year grid
  // isn't pushed down by the full-width legend.
  return (
    <div className="cal-legend-left" ref={rootRef}>
      <YearCalendar
        presence={presence}
        year={year}
        now={now}
        displayTimeZone={displayTimeZone}
        theme={theme}
        weekStartsOn={0}
        locale="en-US"
        hydrateDay={hydrateDay}
        onNavigateYear={onNavigateYear}
        onNavigateToMonth={onNavigateToMonth}
        // OPE-1488 — "View full day →" (and the popover title) open Day view for that
        // date. It used to go to Month view at that day's month.
        onNavigateToDay={navigateToDay}
        renderDayPopover={renderSortedDayPopover}
      />
    </div>
  );
}

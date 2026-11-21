"use client";

// CAL2 — thin client wrapper around the module's <TimeGridCalendar> (Week / Day /
// Custom multi-day hour grids). Like the other view wrappers, the server does the
// D1 query + adapter and passes serializable data; this owns the nav callbacks
// (which write the URL so back/forward + direct links work). All-day events render
// in the top strip; events with confirmed hours (DQ4) render as timed hour blocks.

import { useCallback, useRef } from "react";
import {
  TimeGridCalendar,
  type CalendarEvent,
  type CalendarTheme,
  type TimeGridView,
} from "@jonnyboats/calendar-react";
import "@jonnyboats/calendar-react/styles";
import { useCalendarNav } from "./calendar-nav";
import { useCalendarDayLinks } from "./use-calendar-day-links";

interface Props {
  events: CalendarEvent[];
  /** Host-pinned ISO instant (SSR-stable "now"). */
  now: string;
  displayTimeZone: string;
  theme: CalendarTheme;
  view: TimeGridView;
  /** The focused date the range is built around ("YYYY-MM-DD"). */
  anchor: string;
  /** Custom view day count (2–7); ignored for week/day. */
  customViewDays?: number;
}

export function CalendarTimeGridClient({
  events,
  now,
  displayTimeZone,
  theme,
  view,
  anchor,
  customViewDays,
}: Props) {
  // OPE-1488 — the anchor IS the focus date; every push writes `date=` (and keeps
  // `cal`/`cal_year` in step) so Day → Week → Month stays on the same day.
  const rootRef = useRef<HTMLDivElement>(null);
  const { pushFocus, navigateToDay, switchView } = useCalendarNav(anchor);
  useCalendarDayLinks(rootRef, navigateToDay, switchView);

  // Prev/next/today → move the anchor (server refetches/re-windows).
  const onNavigate = useCallback(
    (next: { anchor: string }) => pushFocus(next.anchor, view),
    [pushFocus, view]
  );

  // `cal-legend-left` keeps the legend in a left sidebar, consistent with the
  // other calendar views (CSS in src/app/globals.css, >=768px).
  return (
    <div className="cal-legend-left" ref={rootRef}>
      <TimeGridCalendar
        events={events}
        now={now}
        displayTimeZone={displayTimeZone}
        view={view}
        anchor={anchor}
        {...(customViewDays ? { customViewDays } : {})}
        theme={theme}
        weekStartsOn={0}
        locale="en-US"
        // Google-Calendar-like spacing: airy hour rows, open scrolled to the
        // morning, and cap the all-day strip so it can't swallow the grid.
        hourHeightPx={48}
        weekScrollAnchorHour={8}
        maxStripLanes={3}
        onNavigate={onNavigate}
        // Click a day-column header → Day view for that date.
        onNavigateToDay={navigateToDay}
      />
    </div>
  );
}

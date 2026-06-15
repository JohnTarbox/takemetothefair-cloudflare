// CAL1 — server component for the SSR Month calendar.
//
// Runs on the edge with the rest of /events: takes the already-fetched calendar
// rows (the same windowed result set the list view uses), maps them through the
// host-owned adapter, pins `now` per request, builds the theme's category colors,
// and hands serializable props to the client wrapper that mounts <MonthCalendar>.

import { toCalendarEvents, type CalendarEventInput } from "@/lib/calendar/to-calendar-event";
import { categoryColorsForEvents } from "@/lib/calendar/colors";
import { parseCalMonth, monthAnchorIso } from "@/lib/calendar/window";
import { CalendarMonthClient } from "./calendar-month-client";
import { ViewToggle } from "./view-toggle";

// MMATF is single-zone; the contract requires a resolvable IANA zone (validated at
// the deploy boundary + render-guarded by the module). Constant here, never inferred.
const DISPLAY_TIME_ZONE = "America/New_York";

interface Props {
  /** The calendar result set from getEvents() (venue joined, eventDayDates attached). */
  events: CalendarEventInput[];
  /** The `cal` search param ("YYYY-MM"), or undefined → current month. */
  cal?: string;
  /** All current search params, so the view toggle can preserve active filters. */
  searchParams: Record<string, string | undefined>;
}

export function CalendarMonthSSR({ events, cal, searchParams }: Props) {
  const calendarEvents = toCalendarEvents(events);
  const initialAnchor = monthAnchorIso(parseCalMonth(cal));
  const now = new Date().toISOString(); // host-pinned per request

  const theme = {
    categoryColors: categoryColorsForEvents(calendarEvents.map((e) => ({ category: e.category }))),
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end print:hidden">
        <ViewToggle view="calendar" searchParams={searchParams} />
      </div>
      <CalendarMonthClient
        events={calendarEvents}
        now={now}
        displayTimeZone={DISPLAY_TIME_ZONE}
        initialAnchor={initialAnchor}
        theme={theme}
      />
    </div>
  );
}

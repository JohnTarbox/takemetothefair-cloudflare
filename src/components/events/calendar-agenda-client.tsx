"use client";

// CAL2 — thin client wrapper around the module's <ScheduleCalendar> (Agenda view).
//
// Mirrors calendar-month-client.tsx: the server does the D1 query + adapter and
// passes only SERIALIZABLE data (events/now/theme); this wrapper owns the callbacks
// that can't cross the RSC boundary. `now` is host-pinned on the server so server
// HTML and first client paint agree.
//
// The calendar query loads the FULL matching window (no pagination), so the whole
// agenda is already in `events`; ScheduleCalendar pages through it client-side via
// `agendaPageSize`. There's no further server window to fetch, so we deliberately
// omit `onLoadMore`.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ScheduleCalendar,
  type CalendarEvent,
  type Occurrence,
  type CalendarTheme,
} from "@jonnyboats/calendar-react";
import "@jonnyboats/calendar-react/styles";

interface Props {
  events: CalendarEvent[];
  /** Host-pinned ISO instant (SSR-stable "now"). */
  now: string;
  displayTimeZone: string;
  theme: CalendarTheme;
  /** Mirrors the `?includePast=true` filter — reveals the "load earlier" affordance. */
  includePast: boolean;
}

export function CalendarAgendaClient({ events, now, displayTimeZone, theme, includePast }: Props) {
  const router = useRouter();

  // Mobile row tap (and `scheduleRowAction:"navigate"`) → the event's detail page.
  const onNavigateToEventPage = useCallback(
    (event: CalendarEvent, _occ: Occurrence) => {
      if (event.url) router.push(event.url);
    },
    [router]
  );

  // `cal-legend-left` moves the category legend into a left sidebar on >=768px
  // (CSS in src/app/globals.css), consistent with Month and Year.
  return (
    <div className="cal-legend-left">
      <ScheduleCalendar
        events={events}
        now={now}
        displayTimeZone={displayTimeZone}
        theme={theme}
        locale="en-US"
        includePast={includePast}
        scheduleRowAction="responsive"
        onNavigateToEventPage={onNavigateToEventPage}
      />
    </div>
  );
}

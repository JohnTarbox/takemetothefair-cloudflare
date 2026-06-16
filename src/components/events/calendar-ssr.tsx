// CAL1/CAL2 — server entry point for the SSR calendar at /events?view=calendar.
//
// Renders the view chrome (the Cards/Table/Calendar ViewToggle and, when CAL2 is on,
// the Month/Agenda/Year sub-view toggle) and dispatches to the active sub-view:
//
//   month  → <CalendarMonthClient>  (CAL1; the only view when CAL2 is off)
//   agenda → <CalendarAgendaClient> (CAL2)
//   year   → <CalendarYearSSR>      (CAL2; its own cheap presence query)
//
// Month + Agenda share the already-fetched calendar window (the same result set the
// list view uses), mapped once through the host-owned adapter. Year loads nothing
// from here — it queries its own per-day presence map. `now` is pinned per request
// so server HTML and first client paint agree (no hydration mismatch).

import { toCalendarEvents, type CalendarEventInput } from "@/lib/calendar/to-calendar-event";
import { categoryColorsForEvents } from "@/lib/calendar/colors";
import {
  parseCalMonth,
  monthAnchorIso,
  parseCalYear,
  parseCalDate,
  parseCalDays,
} from "@/lib/calendar/window";
import { todayIsoUtc } from "@takemetothefair/datetime";
import { CalendarMonthClient } from "./calendar-month-client";
import { CalendarAgendaClient } from "./calendar-agenda-client";
import { CalendarTimeGridClient } from "./calendar-timegrid-client";
import { CalendarYearSSR } from "./calendar-year-ssr";
import { ViewToggle } from "./view-toggle";
import { CalendarSubViewToggle, parseCalSubView } from "./calendar-subview-toggle";

// MMATF is single-zone; the contract requires a resolvable IANA zone (validated at
// the deploy boundary + render-guarded by the module). Constant here, never inferred.
const DISPLAY_TIME_ZONE = "America/New_York";

interface Props {
  /** The calendar result set from getEvents() (venue joined, eventDayDates attached). */
  events: CalendarEventInput[];
  /** All current search params, so the toggles preserve active filters. */
  searchParams: Record<string, string | undefined>;
  /** Whether the CAL2 Agenda/Year sub-views are enabled (else Month-only, no sub-toggle). */
  cal2Enabled: boolean;
}

export function CalendarSSR({ events, searchParams, cal2Enabled }: Props) {
  const subView = cal2Enabled ? parseCalSubView(searchParams.cal_view) : "month";
  // Step 5 — default hides past events; the "Include past events" filter shows them.
  const includePast = searchParams.includePast === "true";
  const now = new Date().toISOString(); // host-pinned per request

  // Month + Agenda consume the loaded window through the same adapter; Year doesn't.
  const calendarEvents =
    subView === "year" ? [] : toCalendarEvents(events, { includePast, todayIso: todayIsoUtc() });
  const theme = {
    categoryColors: categoryColorsForEvents(calendarEvents.map((e) => ({ category: e.category }))),
  };

  let body;
  if (subView === "agenda") {
    body = (
      <CalendarAgendaClient
        events={calendarEvents}
        now={now}
        displayTimeZone={DISPLAY_TIME_ZONE}
        theme={theme}
        includePast={includePast}
      />
    );
  } else if (subView === "year") {
    body = <CalendarYearSSR year={parseCalYear(searchParams.cal_year)} />;
  } else if (subView === "week" || subView === "day" || subView === "custom") {
    body = (
      <CalendarTimeGridClient
        events={calendarEvents}
        now={now}
        displayTimeZone={DISPLAY_TIME_ZONE}
        theme={theme}
        view={subView}
        anchor={parseCalDate(searchParams.cal_date)}
        {...(subView === "custom" ? { customViewDays: parseCalDays(searchParams.cal_days) } : {})}
      />
    );
  } else {
    const initialAnchor = monthAnchorIso(parseCalMonth(searchParams.cal));
    body = (
      <CalendarMonthClient
        events={calendarEvents}
        now={now}
        displayTimeZone={DISPLAY_TIME_ZONE}
        initialAnchor={initialAnchor}
        theme={theme}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        {cal2Enabled ? (
          <CalendarSubViewToggle view={subView} searchParams={searchParams} />
        ) : (
          <span />
        )}
        <ViewToggle view="calendar" searchParams={searchParams} />
      </div>
      {body}
    </div>
  );
}

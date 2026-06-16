"use client";

// CAL2 — thin client wrapper around the module's <YearCalendar>.
//
// The server builds the cheap per-day presence map (calendar-year-ssr.tsx) and
// passes it in; this wrapper owns the navigation callbacks (URL is the source of
// truth, so back/forward + direct links work) and `hydrateDay`, which lazily fetches
// a single day's full events for the day popover when a dotted day is clicked.

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { YearCalendar, type CalendarEvent, type CalendarTheme } from "@jonnyboats/calendar-react";
import type { PresenceMap } from "@jonnyboats/calendar-core";
import "@jonnyboats/calendar-react/styles";

interface Props {
  presence: PresenceMap;
  year: number;
  /** Host-pinned ISO instant (SSR-stable today-disc). */
  now: string;
  displayTimeZone: string;
  theme: CalendarTheme;
}

export function CalendarYearClient({ presence, year, now, displayTimeZone, theme }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Build a `/events?...` URL preserving active filters; reset pagination.
  const pushWith = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", "calendar");
      params.delete("page");
      mutate(params);
      router.push(`/events?${params.toString()}`);
    },
    [router, searchParams]
  );

  // Prev/next/Today → refetch presence for the new year (server re-renders).
  const onNavigateYear = useCallback(
    (y: number) =>
      pushWith((p) => {
        p.set("cal_view", "year");
        p.set("cal_year", String(y));
      }),
    [pushWith]
  );

  // Month title click → Month view anchored to that month.
  const onNavigateToMonth = useCallback(
    (monthAnchor: string) =>
      pushWith((p) => {
        p.set("cal_view", "month");
        p.set("cal", monthAnchor.slice(0, 7));
      }),
    [pushWith]
  );

  // "View full day →" from the day popover → Month view at that day's month.
  const onNavigateToDay = useCallback(
    (date: string) =>
      pushWith((p) => {
        p.set("cal_view", "month");
        p.set("cal", date.slice(0, 7));
      }),
    [pushWith]
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
    <div className="cal-legend-left">
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
        onNavigateToDay={onNavigateToDay}
      />
    </div>
  );
}

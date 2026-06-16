"use client";

// CAL1 — the thin client wrapper around the module's <MonthCalendar>.
//
// <MonthCalendar> is a client component and takes interactive callbacks
// (onNavigate, etc.) that cannot cross the RSC boundary as props. So the server
// component (calendar-ssr.tsx) does the D1 query + adapter and passes only
// SERIALIZABLE data in (events/now/anchor/theme); this wrapper owns the callbacks.
// `now` is host-pinned on the server and passed through unchanged, so server HTML
// and first client paint agree (no hydration mismatch).

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MonthCalendar, type CalendarEvent, type CalendarTheme } from "@jonnyboats/calendar-react";
import "@jonnyboats/calendar-react/styles";

interface Props {
  events: CalendarEvent[];
  /** Host-pinned ISO instant (SSR-stable "now"). */
  now: string;
  displayTimeZone: string;
  /** Mid-month DayKey of the visible month. */
  initialAnchor: string;
  theme: CalendarTheme;
}

export function CalendarMonthClient({ events, now, displayTimeZone, initialAnchor, theme }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Visible period changed (next/prev/today/jump) → make the URL the source of
  // truth so back/forward + direct links work and the server re-renders the month.
  const onNavigate = useCallback(
    (next: { anchor: string; window: { start: string; end: string } }) => {
      const month = next.anchor.slice(0, 7); // "YYYY-MM"
      const params = new URLSearchParams(searchParams.toString());
      params.set("view", "calendar");
      params.set("cal", month);
      params.delete("page");
      router.push(`/events?${params.toString()}`);
    },
    [router, searchParams]
  );

  // `cal-legend-left` drives a CSS-grid override (src/app/globals.css) that moves
  // the module's category legend into a left sidebar on >=768px. Month-only —
  // Agenda/Year share `.cm-root` but aren't wrapped, so they're unaffected.
  return (
    <div className="cal-legend-left">
      <MonthCalendar
        events={events}
        now={now}
        displayTimeZone={displayTimeZone}
        initialAnchor={initialAnchor}
        theme={theme}
        weekStartsOn={0}
        locale="en-US"
        onNavigate={onNavigate}
      />
    </div>
  );
}

// CAL2 — server component for the SSR Year calendar.
//
// Runs on the edge: builds the cheap per-day presence map for the selected year
// (its OWN narrow query — see presence-query.ts — not the heavy getEvents list),
// pins `now` per request, and hands serializable props to the client wrapper that
// mounts <YearCalendar>.

import { getCloudflareDb } from "@/lib/cloudflare";
import { getYearPresence } from "@/lib/calendar/presence-query";
import { buildCalendarTheme } from "@/lib/calendar/theme";
import { CalendarYearClient } from "./calendar-year-client";

const DISPLAY_TIME_ZONE = "America/New_York";

export async function CalendarYearSSR({ year }: { year: number }) {
  const db = getCloudflareDb();
  const { presence, categoryColors } = await getYearPresence(db, year);
  const now = new Date().toISOString(); // host-pinned per request

  return (
    <CalendarYearClient
      presence={presence}
      year={year}
      now={now}
      displayTimeZone={DISPLAY_TIME_ZONE}
      theme={buildCalendarTheme(categoryColors)}
    />
  );
}

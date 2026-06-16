// CAL2 — day-hydration endpoint for the Year view's day popover.
//
// When a user clicks a dotted day in the Year grid, YearCalendar's `hydrateDay`
// fetches this route to populate the popover with that day's full events (the Year
// presence map carries no event payloads, by design). Returns the same adapted
// `CalendarEvent[]` the SSR views use, so the module renders it without further
// mapping.

import type { NextRequest } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getEventsForDay } from "@/lib/calendar/presence-query";
import { logError } from "@/lib/logger";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !DATE_RE.test(date)) {
    return Response.json({ error: "invalid date (expected YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    const db = getCloudflareDb();
    const events = await getEventsForDay(db, date);
    // Public, deterministic for a given day within the 5-min ISR window; cache at
    // the edge so repeat day-clicks don't re-query D1.
    return Response.json(events, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (e) {
    // Degrade to an empty day (the popover shows "no events") rather than a 500 —
    // a failed hydrate must never break the Year grid. Log for ops visibility.
    await logError(getCloudflareDb(), {
      message: "calendar-day hydrate failed",
      error: e,
      source: "app/api/events/calendar-day:GET",
      context: { date },
    });
    return Response.json([], { status: 200 });
  }
}

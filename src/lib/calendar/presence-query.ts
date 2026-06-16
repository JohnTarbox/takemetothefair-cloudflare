// CAL2 — data layer for the Year view (and its day-popover hydration).
//
// The Year window is deliberately CHEAP: `buildPresence()` reduces a year of events
// to a per-day per-category presence map (`Record<DayKey, string[]>`, no event
// payloads), so the whole year is a few KB regardless of event count. We therefore
// run a NARROW query here (no venue/promoter join, no vendor batch) rather than
// reuse the heavy `getEvents()` calendar branch — and, unlike that branch, we load
// the WHOLE year (past + future), since the Year overview dots past days too.
//
// `getEventsForDay()` shares the same loader to hydrate the day popover when a user
// clicks a dotted day in the Year grid (YearCalendar's `hydrateDay`).

import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { events as eventsTable, eventDays } from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import type { getCloudflareDb } from "@/lib/cloudflare";
import { buildPresence, presenceCategories, type PresenceMap } from "@jonnyboats/calendar-core";
import { validateConfig, type CalendarEvent } from "@jonnyboats/calendar-contract";
import { toCalendarEvents, type CalendarEventInput } from "./to-calendar-event";
import { colorForCategory } from "./colors";

// MMATF is single-zone; the contract requires a resolvable IANA zone (the deploy
// boundary validates it). Constant here, never inferred — matches the SSR components.
const DISPLAY_TIME_ZONE = "America/New_York";

/** Minimal config for `buildPresence` — only `displayTimeZone` is required. */
const CAL_CONFIG = validateConfig({ displayTimeZone: DISPLAY_TIME_ZONE }).data!;

/** The Drizzle D1 handle type, derived so it tracks the binding without a named export. */
type Database = ReturnType<typeof getCloudflareDb>;

/** Drizzle stores `integer(mode:"timestamp")` as unix SECONDS. */
const toUnixSec = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * Load the public events whose date span intersects [start, end], shaped for the
 * adapter. Narrow projection (no joins); `venue` is null because presence/day
 * popovers don't need venue bits for placement. Discontinuous events get their
 * public `event_days` dates attached, exactly like the `getEvents()` calendar path.
 */
async function loadInputsInRange(
  db: Database,
  start: Date,
  end: Date
): Promise<CalendarEventInput[]> {
  const rows = await db
    .select({
      id: eventsTable.id,
      name: eventsTable.name,
      slug: eventsTable.slug,
      categories: eventsTable.categories,
      discontinuousDates: eventsTable.discontinuousDates,
      startDate: eventsTable.startDate,
      endDate: eventsTable.endDate,
    })
    .from(eventsTable)
    .where(
      and(
        isPublicEventStatus(),
        isNotNull(eventsTable.startDate),
        // Intersection: starts on/before the window end AND ends on/after its start.
        // COALESCE so single-day events (NULL end_date) test their start_date.
        lte(eventsTable.startDate, end),
        sql`COALESCE(${eventsTable.endDate}, ${eventsTable.startDate}) >= ${toUnixSec(start)}`
      )
    );

  // Attach event_days for discontinuous events (public days only), batched to stay
  // under D1's bind-variable cap — same pattern as getEvents().
  const discontinuousIds = rows.filter((r) => r.discontinuousDates).map((r) => r.id);
  const daysByEvent = new Map<string, string[]>();
  if (discontinuousIds.length > 0) {
    const BATCH_SIZE = 50;
    for (let i = 0; i < discontinuousIds.length; i += BATCH_SIZE) {
      const batch = discontinuousIds.slice(i, i + BATCH_SIZE);
      const dayRows = await db
        .select({ eventId: eventDays.eventId, date: eventDays.date })
        .from(eventDays)
        .where(and(inArray(eventDays.eventId, batch), eq(eventDays.vendorOnly, false)));
      for (const row of dayRows) {
        const existing = daysByEvent.get(row.eventId) || [];
        existing.push(row.date);
        daysByEvent.set(row.eventId, existing);
      }
    }
  }

  return rows.map((r) => ({
    ...r,
    venue: null,
    ...(r.discontinuousDates && daysByEvent.has(r.id)
      ? { eventDayDates: daysByEvent.get(r.id) }
      : {}),
  })) as CalendarEventInput[];
}

export interface YearPresenceResult {
  presence: PresenceMap;
  /** category → color for the categories actually present this year (legend swatches). */
  categoryColors: Record<string, string>;
}

/** Build the per-day per-category presence map for a calendar year. */
export async function getYearPresence(db: Database, year: number): Promise<YearPresenceResult> {
  const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const inputs = await loadInputsInRange(db, start, end);
  // includePast: true — the Year overview dots every day in the year, past included.
  const calEvents = toCalendarEvents(inputs, { includePast: true });
  const presence = buildPresence(calEvents, CAL_CONFIG, year);

  const categoryColors: Record<string, string> = {};
  for (const cat of presenceCategories(presence)) categoryColors[cat] = colorForCategory(cat);

  return { presence, categoryColors };
}

/** Adapted events intersecting a single day — hydrates the Year day popover. */
export async function getEventsForDay(db: Database, dayIso: string): Promise<CalendarEvent[]> {
  // dayIso is "YYYY-MM-DD"; build a UTC day window [00:00, 23:59:59].
  const [y, m, d] = dayIso.split("-").map(Number);
  const start = new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0));
  const end = new Date(Date.UTC(y!, m! - 1, d!, 23, 59, 59));
  const inputs = await loadInputsInRange(db, start, end);
  // includePast: true — a clicked day may be in the past; the popover should still
  // show what happened. (The Year view itself only dots days that have events.)
  return toCalendarEvents(inputs, { includePast: true });
}

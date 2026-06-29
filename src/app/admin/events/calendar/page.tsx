import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, ArrowLeft, Plus } from "lucide-react";
import { gte, inArray } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, promoters } from "@/lib/db/schema";
import { EventsView } from "@/components/events/events-view";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Admin event calendar — the host for the F3 C2 (2026-06-11) "+ Add event"
 * affordance. Rendering EventsView with `isAdmin` makes empty day cells
 * clickable (deep-linking to /admin/events/new?date=…) and adds an "Add event"
 * action inside the day popover, so an operator can schedule straight from the
 * month grid while seeing what's already booked.
 */
async function getAllEvents() {
  const db = getCloudflareDb();
  try {
    // Admin working set: everything ending in the last ~90 days onward (recent
    // history + all future). Bounds the client payload vs. all ~1k rows while
    // covering the dates an operator actually schedules into. The month grid
    // navigates freely; out-of-window months simply render empty.
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - 90);

    // Single-table select; venue + promoter are attached from batched lookups
    // below. The former 3-table leftJoin returned a result row of events(71) +
    // venues(32) + promoters(17) = 120 columns, over D1's hard 100-column
    // result-set cap — the same outage shape as /api/admin/events (OPE-26).
    const eventRows = await db.select().from(events).where(gte(events.endDate, windowStart));

    if (eventRows.length === 0) return [];

    const BATCH_SIZE = 50; // D1 bind-variable cap per statement

    const venueIds = [
      ...new Set(eventRows.map((e) => e.venueId).filter((id): id is string => id != null)),
    ];
    const venueMap = new Map<string, typeof venues.$inferSelect>();
    for (let i = 0; i < venueIds.length; i += BATCH_SIZE) {
      const batch = venueIds.slice(i, i + BATCH_SIZE);
      const rows = await db.select().from(venues).where(inArray(venues.id, batch));
      for (const v of rows) venueMap.set(v.id, v);
    }

    const promoterIds = [
      ...new Set(eventRows.map((e) => e.promoterId).filter((id): id is string => id != null)),
    ];
    const promoterMap = new Map<string, typeof promoters.$inferSelect>();
    for (let i = 0; i < promoterIds.length; i += BATCH_SIZE) {
      const batch = promoterIds.slice(i, i + BATCH_SIZE);
      const rows = await db.select().from(promoters).where(inArray(promoters.id, batch));
      for (const p of rows) promoterMap.set(p.id, p);
    }

    return eventRows.map((e) => ({
      ...e,
      venue: e.venueId ? (venueMap.get(e.venueId) ?? null) : null,
      promoter: e.promoterId ? (promoterMap.get(e.promoterId) ?? null) : null,
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching admin calendar events",
      error: e,
      source: "app/admin/events/calendar/page.tsx:getAllEvents",
    });
    return [];
  }
}

export default async function AdminEventCalendarPage() {
  const session = await auth();
  // The admin layout already gates, but check explicitly so a non-admin gets a
  // clean redirect rather than relying solely on the layout.
  if (session?.user?.role !== "ADMIN") {
    redirect("/login");
  }

  const eventsList = await getAllEvents();

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/events"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Events
        </Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Calendar className="w-6 h-6" />
            Event Calendar
          </h1>
          <p className="text-muted-foreground mt-1">
            All events from the last 90 days onward. Click an empty day to add an event on that
            date, or a day with events to see the full list.
          </p>
        </div>
        <Link
          href="/admin/events/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-royal px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-navy"
        >
          <Plus className="w-4 h-4" />
          New event
        </Link>
      </div>

      <EventsView events={eventsList} view="calendar" isAdmin basePath="/admin/events" />
    </div>
  );
}

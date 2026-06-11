import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, ArrowLeft, Plus } from "lucide-react";
import { eq, gte } from "drizzle-orm";
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

    const results = await db
      .select({ event: events, venue: venues, promoter: promoters })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(gte(events.endDate, windowStart));

    return results.map((r) => ({
      ...r.event,
      venue: r.venue,
      promoter: r.promoter,
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

import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, venues, promoters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { EventsView } from "@/components/events/events-view";
import { logError } from "@/lib/logger";

export const runtime = "edge";

async function getVendorEvents(userId: string) {
  const db = getCloudflareDb();

  try {
    const vendorResults = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1);

    if (vendorResults.length === 0) return { events: [], vendorCoords: null };

    const vendor = vendorResults[0];

    // Active statuses — events the vendor is committed to or considering
    const activeStatuses = [
      "INVITED",
      "INTERESTED",
      "APPLIED",
      "WAITLISTED",
      "APPROVED",
      "CONFIRMED",
    ];

    const results = await db
      .select({
        event: events,
        venue: venues,
        promoter: promoters,
        applicationStatus: eventVendors.status,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(eq(eventVendors.vendorId, vendor.id));

    const eventsList = results
      .filter((r) => activeStatuses.includes(r.applicationStatus))
      .map((r) => ({
        ...r.event,
        venue: r.venue,
        promoter: r.promoter,
      }));

    const vendorCoords =
      vendor.latitude && vendor.longitude ? { lat: vendor.latitude, lng: vendor.longitude } : null;

    return { events: eventsList, vendorCoords };
  } catch (e) {
    await logError(db, {
      message: "Error fetching vendor calendar events",
      error: e,
      source: "app/vendor/calendar/page.tsx:getVendorEvents",
      context: { userId },
    });
    return { events: [], vendorCoords: null };
  }
}

export default async function VendorCalendarPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const { events: eventsList, vendorCoords } = await getVendorEvents(session.user.id);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/vendor/applications"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Applications
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Calendar className="w-6 h-6" />
          My Event Calendar
        </h1>
        <p className="text-gray-600 mt-1">
          All events you&apos;re applied to, approved for, or confirmed at — shown on a calendar.
        </p>
      </div>

      <EventsView
        events={eventsList}
        view="calendar"
        emptyMessage="No active event applications yet. Apply to events to see them on your calendar."
        myEvents
        vendorCoords={vendorCoords}
        basePath="/vendor/calendar"
      />
    </div>
  );
}

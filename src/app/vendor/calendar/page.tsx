import Link from "next/link";
import { Calendar, ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/require-role";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, venues, promoters } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { EventsView } from "@/components/events/events-view";
import { logError } from "@/lib/logger";
import { publicEventColumns } from "@/lib/db/event-join-projection";
import { PrintButton } from "@/components/print/PrintButton";
import { PrintEventSheetFooter } from "@/components/print/PrintEventSheetFooter";

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

    // D1 caps a result row at 100 columns. This used to select `event: events`
    // (the whole row) beside the narrowed venue/promoter objects below, which
    // was fine at events(62) and broke every vendor's calendar once `events`
    // reached 83: 83 + 10 + 7 + 1 = 101 → "too many columns in result set"
    // (OPE-1720). It now takes the PUBLIC allow-list, as every other
    // EventsView caller does — which also stops this page shipping private
    // event columns (suggester email, gate traces, merge pointers…) into the
    // client component's RSC payload (OPE-1387). Venue/promoter fields mirror
    // `src/lib/db/event-join-projection.ts`; inlined because this shape adds
    // `applicationStatus` and uses a singular `event:` key.
    // scripts/check-d1-100col-joins.ts counts all three objects.
    const results = await db
      .select({
        event: publicEventColumns,
        venue: {
          id: venues.id,
          name: venues.name,
          slug: venues.slug,
          address: venues.address,
          city: venues.city,
          state: venues.state,
          zip: venues.zip,
          latitude: venues.latitude,
          longitude: venues.longitude,
          googleMapsUrl: venues.googleMapsUrl,
        },
        promoter: {
          id: promoters.id,
          userId: promoters.userId,
          companyName: promoters.companyName,
          slug: promoters.slug,
          logoUrl: promoters.logoUrl,
          verified: promoters.verified,
          website: promoters.website,
        },
        applicationStatus: eventVendors.status,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(eq(eventVendors.vendorId, vendor.id));

    // Cast back to full row types for the EventsView prop contract.
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    // EventRow derived from results so projection changes flow through.
    type EventRow = (typeof results)[number];
    const eventsList = results
      .filter((r: EventRow) => activeStatuses.includes(r.applicationStatus))
      .map((r: EventRow) => ({
        ...r.event,
        venue: r.venue as FullVenue | null,
        promoter: r.promoter as FullPromoter | null,
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

export const dynamic = "force-dynamic";

export default async function VendorCalendarPage() {
  const session = await requireRole("VENDOR", "/vendor/calendar");

  const { events: eventsList, vendorCoords } = await getVendorEvents(session.user.id);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/vendor/applications"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Applications
        </Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Calendar className="w-6 h-6" />
            My Event Calendar
          </h1>
          <p className="text-muted-foreground mt-1">
            All events you&apos;re applied to, approved for, or confirmed at — shown on a calendar.
          </p>
        </div>
        {/* MMATF-UIUX-PrintSheet-Spec Item 2 — vendor "print my schedule".
            Single button triggers window.print(); the calendar's own
            print: variants + the global @media print rules format the
            output. Add .print-landscape on the EventsView root would
            opt this view into landscape orientation if calendar print
            ends up cramped on portrait. */}
        <PrintButton label="Print schedule" />
      </div>

      <EventsView
        events={eventsList}
        view="calendar"
        emptyMessage="No active event applications yet. Apply to events to see them on your calendar."
        myEvents
        vendorCoords={vendorCoords}
        basePath="/vendor/calendar"
      />

      <PrintEventSheetFooter
        canonicalUrl="https://meetmeatthefair.com/vendor/calendar"
        contextLabel="Your live schedule (sign in required)"
      />
    </div>
  );
}

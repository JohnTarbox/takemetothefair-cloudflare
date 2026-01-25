import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, MapPin, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";


const statusColors: Record<string, "default" | "success" | "warning" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
};

async function getApplications(userId: string) {
  try {
    const db = getCloudflareDb();

    // Get the vendor for this user
    const vendorResults = await db
      .select()
      .from(vendors)
      .where(eq(vendors.userId, userId))
      .limit(1);

    if (vendorResults.length === 0) return [];

    const vendor = vendorResults[0];

    // Get event applications with events and venues
    const applicationResults = await db
      .select()
      .from(eventVendors)
      .leftJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(eventVendors.vendorId, vendor.id))
      .orderBy(desc(eventVendors.createdAt));

    return applicationResults
      .filter((a) => a.events !== null)
      .map((a) => ({
        ...a.event_vendors,
        event: {
          ...a.events!,
          venue: a.venues!,
        },
      }));
  } catch (e) {
    console.error("Error fetching applications:", e);
    return [];
  }
}

export default async function VendorApplicationsPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const applications = await getApplications(session.user.id);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Event Applications</h1>
        <p className="mt-1 text-gray-600">
          Track your applications to participate in events
        </p>
      </div>

      {applications.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900">
              No applications yet
            </h3>
            <p className="mt-1 text-gray-500">
              Browse events and apply to participate as a vendor
            </p>
            <Link
              href="/events"
              className="mt-4 inline-block text-blue-600 hover:text-blue-700 font-medium"
            >
              Browse Events
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {applications.map((app) => (
            <Card key={app.id}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/events/${app.event.slug}`}
                        className="text-lg font-semibold text-gray-900 hover:text-blue-600"
                      >
                        {app.event.name}
                      </Link>
                      <Badge variant={statusColors[app.status]}>
                        {app.status}
                      </Badge>
                    </div>
                    <div className="mt-2 space-y-1 text-sm text-gray-600">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4" />
                        {formatDateRange(app.event.startDate, app.event.endDate)}
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4" />
                        {app.event.venue.name}, {app.event.venue.city},{" "}
                        {app.event.venue.state}
                      </div>
                      {app.boothInfo && (
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" />
                          Booth: {app.boothInfo}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

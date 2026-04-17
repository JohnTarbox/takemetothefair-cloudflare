import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, MapPin, Clock, AlertTriangle, FileText, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateRange } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { vendors, eventVendors, events, venues } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { STATUS_BADGE_VARIANTS, STATUS_LABELS } from "@/lib/vendor-status";
import { logError } from "@/lib/logger";

export const runtime = "edge";

async function getApplications(userId: string) {
  const db = getCloudflareDb();

  try {
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
          venue: a.venues ?? null,
        },
      }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching applications",
      error: e,
      source: "app/vendor/applications/page.tsx:getApplications",
      context: { userId },
    });
    return [];
  }
}

// Active statuses that represent a real commitment (not rejected/withdrawn/cancelled)
const ACTIVE_STATUSES = new Set([
  "INVITED",
  "INTERESTED",
  "APPLIED",
  "WAITLISTED",
  "APPROVED",
  "CONFIRMED",
]);

// Detect date conflicts between active applications
function detectConflicts(
  applications: Awaited<ReturnType<typeof getApplications>>
): Map<string, string[]> {
  const conflicts = new Map<string, string[]>();
  const active = applications.filter((a) => ACTIVE_STATUSES.has(a.status));

  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (!a.event.startDate || !a.event.endDate) continue;
    const aStart = new Date(a.event.startDate).getTime();
    const aEnd = new Date(a.event.endDate).getTime();

    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (!b.event.startDate || !b.event.endDate) continue;
      const bStart = new Date(b.event.startDate).getTime();
      const bEnd = new Date(b.event.endDate).getTime();

      // Overlap: A starts before B ends AND A ends after B starts
      if (aStart <= bEnd && aEnd >= bStart) {
        const aConflicts = conflicts.get(a.id) || [];
        aConflicts.push(b.event.name);
        conflicts.set(a.id, aConflicts);

        const bConflicts = conflicts.get(b.id) || [];
        bConflicts.push(a.event.name);
        conflicts.set(b.id, bConflicts);
      }
    }
  }
  return conflicts;
}

export default async function VendorApplicationsPage() {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  const applications = await getApplications(session.user.id);
  const conflicts = detectConflicts(applications);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Event Applications</h1>
        <p className="mt-1 text-gray-600">Track your applications to participate in events</p>
      </div>

      {applications.length === 0 ? (
        <Card className="border-stone-100 bg-stone-50">
          <CardContent className="py-12 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-sage-50 flex items-center justify-center mb-4">
              <FileText className="w-7 h-7 text-sage-700" aria-hidden />
            </div>
            <h3 className="text-lg font-semibold text-stone-900">No applications yet</h3>
            <p className="mt-1 text-sm text-stone-600 max-w-md mx-auto">
              Browse upcoming events and apply to participate as a vendor. Make sure your profile is
              complete first — promoters look at it before accepting.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 justify-center">
              <Link href="/events">
                <Button>
                  <Calendar className="w-4 h-4 mr-2" />
                  Browse events
                </Button>
              </Link>
              <Link href="/vendor/suggest-event">
                <Button variant="outline">
                  <Sparkles className="w-4 h-4 mr-2" />
                  Suggest an event
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {applications.map((app) => (
            <Card key={app.id}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 flex-wrap">
                      <Link
                        href={`/events/${app.event.slug}`}
                        className="text-lg font-semibold text-gray-900 hover:text-blue-600"
                      >
                        {app.event.name}
                      </Link>
                      <Badge
                        variant={
                          STATUS_BADGE_VARIANTS[app.status as keyof typeof STATUS_BADGE_VARIANTS] ??
                          "default"
                        }
                      >
                        {STATUS_LABELS[app.status as keyof typeof STATUS_LABELS] ?? app.status}
                      </Badge>
                    </div>
                    <div className="mt-2 space-y-1 text-sm text-gray-600">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4" />
                        {formatDateRange(app.event.startDate, app.event.endDate)}
                        <AddToCalendar
                          title={app.event.name}
                          description={app.event.description || undefined}
                          location={
                            app.event.venue
                              ? `${app.event.venue.name}, ${app.event.venue.address || ""}, ${app.event.venue.city}, ${app.event.venue.state} ${app.event.venue.zip || ""}`
                              : undefined
                          }
                          startDate={app.event.startDate}
                          endDate={app.event.endDate}
                          url={`https://meetmeatthefair.com/events/${app.event.slug}`}
                          variant="icon"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4" />
                        {app.event.venue
                          ? `${app.event.venue.name}, ${app.event.venue.city}, ${app.event.venue.state}`
                          : "Venue TBA"}
                      </div>
                      {app.boothInfo && (
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" />
                          Booth: {app.boothInfo}
                        </div>
                      )}
                    </div>
                    {conflicts.has(app.id) && (
                      <div className="mt-2 flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <span>Date conflict with: {conflicts.get(app.id)!.join(", ")}</span>
                      </div>
                    )}
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

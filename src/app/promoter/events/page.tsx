import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Eye, Pencil, Calendar, Copy, FileText, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { promoters, events, venues, eventVendors } from "@/lib/db/schema";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { AddToCalendar } from "@/components/events/AddToCalendar";
import { logError } from "@/lib/logger";

export const runtime = "edge";

const statusColors: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  DRAFT: "default",
  PENDING: "warning",
  TENTATIVE: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "default",
};

interface PromoterEvent {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date | string | null;
  endDate: Date | string | null;
  featured: boolean | null;
  viewCount: number | null;
  description: string | null;
  venueName: string;
  vendorCounts: {
    applied: number;
    confirmed: number;
    total: number;
  };
}

async function getPromoterEvents(userId: string): Promise<PromoterEvent[]> {
  const db = getCloudflareDb();

  try {
    const [promoter] = await db
      .select()
      .from(promoters)
      .where(eq(promoters.userId, userId))
      .limit(1);
    if (!promoter) return [];

    const rows = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.promoterId, promoter.id))
      .orderBy(desc(events.createdAt));

    if (rows.length === 0) return [];

    const eventIds = rows.map((r) => r.events.id);

    // One aggregated query for vendor counts across all this promoter's events
    const counts = await db
      .select({
        eventId: eventVendors.eventId,
        status: eventVendors.status,
        n: sql<number>`count(*)`,
      })
      .from(eventVendors)
      .where(inArray(eventVendors.eventId, eventIds))
      .groupBy(eventVendors.eventId, eventVendors.status);

    const countByEvent = new Map<string, { applied: number; confirmed: number; total: number }>();
    for (const row of counts) {
      const entry = countByEvent.get(row.eventId) ?? { applied: 0, confirmed: 0, total: 0 };
      entry.total += Number(row.n);
      if (row.status === "APPLIED" || row.status === "WAITLISTED") {
        entry.applied += Number(row.n);
      } else if (row.status === "APPROVED" || row.status === "CONFIRMED") {
        entry.confirmed += Number(row.n);
      }
      countByEvent.set(row.eventId, entry);
    }

    return rows.map((r) => ({
      id: r.events.id,
      name: r.events.name,
      slug: r.events.slug,
      status: r.events.status,
      startDate: r.events.startDate,
      endDate: r.events.endDate,
      featured: r.events.featured,
      viewCount: r.events.viewCount,
      description: r.events.description,
      venueName: r.venues?.name || "Unknown",
      vendorCounts: countByEvent.get(r.events.id) ?? { applied: 0, confirmed: 0, total: 0 },
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching promoter events",
      error: e,
      source: "app/promoter/events/page.tsx:getPromoterEvents",
      context: { userId },
    });
    return [];
  }
}

export default async function PromoterEventsPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const allEvents = await getPromoterEvents(session.user.id);
  const drafts = allEvents.filter((e) => e.status === "DRAFT");
  const submitted = allEvents.filter((e) => e.status !== "DRAFT");

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Events</h1>
          <p className="mt-1 text-gray-600">Manage your events and track their status</p>
        </div>
        <Link href="/promoter/events/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Create Event
          </Button>
        </Link>
      </div>

      {allEvents.length === 0 ? (
        <Card className="border-stone-100 bg-stone-50">
          <CardContent className="py-12 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-amber-light flex items-center justify-center mb-4">
              <Calendar className="w-7 h-7 text-amber-dark" aria-hidden />
            </div>
            <h3 className="text-lg font-semibold text-stone-900">List your first event</h3>
            <p className="mt-1 text-sm text-stone-600 max-w-md mx-auto">
              Share your fair, festival, or show with vendors and attendees across New England. Your
              event will be reviewed before it goes live.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 justify-center">
              <Link href="/promoter/events/new">
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  Create event
                </Button>
              </Link>
              <Link href="/events">
                <Button variant="outline">See example events</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {drafts.length > 0 && (
            <Card className="border-amber-dark/30 bg-amber-light/40">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <FileText className="w-5 h-5 text-amber-dark" aria-hidden />
                  <h2 className="text-lg font-semibold text-stone-900">
                    Drafts in progress ({drafts.length})
                  </h2>
                </div>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-stone-100">
                  {drafts.map((event) => (
                    <div key={event.id} className="py-4 flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-stone-900 truncate">
                          {event.name || "(Untitled draft)"}
                        </h3>
                        <div className="mt-1 text-sm text-stone-600">
                          {event.venueName !== "Unknown" && (
                            <span className="mr-3">{event.venueName}</span>
                          )}
                          {event.startDate && <span>{formatDate(event.startDate)}</span>}
                        </div>
                      </div>
                      <Link href={`/promoter/events/new?draft=${event.id}`}>
                        <Button size="sm">Continue editing</Button>
                      </Link>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {submitted.length > 0 && (
            <Card>
              <CardHeader>
                <p className="text-sm text-gray-600">
                  {submitted.length} event{submitted.length === 1 ? "" : "s"}
                </p>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-stone-100">
                  {submitted.map((event) => (
                    <div key={event.id} className="py-4 flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <h3 className="font-medium text-gray-900">{event.name}</h3>
                          <Badge variant={statusColors[event.status] ?? "default"}>
                            {event.status}
                          </Badge>
                          {event.featured && <Badge variant="warning">Featured</Badge>}
                        </div>
                        <div className="mt-1 flex items-center gap-4 text-sm text-gray-500 flex-wrap">
                          <span>{event.venueName}</span>
                          {event.startDate && (
                            <span className="flex items-center gap-1">
                              {formatDate(event.startDate)}
                              <AddToCalendar
                                title={event.name}
                                description={event.description || undefined}
                                location={event.venueName}
                                startDate={event.startDate}
                                endDate={event.endDate}
                                url={`https://meetmeatthefair.com/events/${event.slug}`}
                                variant="icon"
                              />
                            </span>
                          )}
                          <span className="inline-flex items-center gap-2 text-xs">
                            {event.vendorCounts.applied > 0 && (
                              <span className="inline-flex items-center gap-1 bg-amber-light text-amber-dark px-2 py-0.5 rounded-full font-medium">
                                {event.vendorCounts.applied} applied
                              </span>
                            )}
                            {event.vendorCounts.confirmed > 0 && (
                              <span className="inline-flex items-center gap-1 bg-sage-50 text-sage-700 px-2 py-0.5 rounded-full font-medium">
                                <CheckCircle2 className="w-3 h-3" aria-hidden />
                                {event.vendorCounts.confirmed} confirmed
                              </span>
                            )}
                            {event.vendorCounts.total === 0 && (
                              <span className="text-stone-600">0 vendors</span>
                            )}
                          </span>
                          <span>{event.viewCount ?? 0} views</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {event.status === "APPROVED" && (
                          <Link href={`/events/${event.slug}`}>
                            <Button variant="ghost" size="sm" aria-label="View public page">
                              <Eye className="w-4 h-4" />
                            </Button>
                          </Link>
                        )}
                        <Link
                          href={`/promoter/events/new?duplicate=${event.id}`}
                          aria-label="Duplicate this event"
                        >
                          <Button variant="ghost" size="sm">
                            <Copy className="w-4 h-4" />
                          </Button>
                        </Link>
                        <Link href={`/promoter/events/${event.id}/edit`} aria-label="Edit event">
                          <Button variant="ghost" size="sm">
                            <Pencil className="w-4 h-4" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

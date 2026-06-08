import Link from "next/link";
import { Calendar, MapPin, Store, Users, Clock, UserPlus, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, promoters, users, eventVendors } from "@/lib/db/schema";
import { eq, count, and } from "drizzle-orm";
import { isPublicVendorStatus } from "@/lib/vendor-status";
import { upcomingEndPredicate } from "@/lib/event-dates";
import { eventJoinProjection, eventVenueJoinProjection } from "@/lib/db/event-join-projection";
import { EventVendorsPanel } from "@/components/admin/event-vendors-panel";
import { SchemaOrgSyncButton } from "@/components/admin/SchemaOrgSyncButton";
import { logError } from "@/lib/logger";

export const runtime = "edge";

async function getStats() {
  const db = getCloudflareDb();

  try {
    const [
      totalEventsResult,
      pendingEventsResult,
      totalVenuesResult,
      totalVendorsResult,
      totalPromotersResult,
      totalUsersResult,
      totalEventVendorsResult,
    ] = await Promise.all([
      db.select({ count: count() }).from(events),
      db.select({ count: count() }).from(events).where(eq(events.status, "PENDING")),
      db.select({ count: count() }).from(venues),
      db.select({ count: count() }).from(vendors),
      db.select({ count: count() }).from(promoters),
      db.select({ count: count() }).from(users),
      db.select({ count: count() }).from(eventVendors).where(isPublicVendorStatus()),
    ]);

    return {
      totalEvents: totalEventsResult[0]?.count || 0,
      pendingEvents: pendingEventsResult[0]?.count || 0,
      totalVenues: totalVenuesResult[0]?.count || 0,
      totalVendors: totalVendorsResult[0]?.count || 0,
      totalPromoters: totalPromotersResult[0]?.count || 0,
      totalUsers: totalUsersResult[0]?.count || 0,
      totalEventVendors: totalEventVendorsResult[0]?.count || 0,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching stats",
      error: e,
      source: "app/admin/page.tsx:getStats",
    });
    return {
      totalEvents: 0,
      pendingEvents: 0,
      totalVenues: 0,
      totalVendors: 0,
      totalPromoters: 0,
      totalUsers: 0,
      totalEventVendors: 0,
    };
  }
}

async function getRecentSubmissions() {
  const db = getCloudflareDb();

  try {
    // Narrow projection — D1 caps result rows at 100 columns and the
    // unfiltered events+venues+promoters join is 104. See
    // src/lib/db/event-join-projection.ts for the audit + maintenance
    // contract. Deferred from PR #327 (1 err/day signal); now picked
    // up because the page-error canary (PR #329) would otherwise
    // dispatch on it every admin visit.
    const results = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.status, "PENDING"))
      .orderBy(events.createdAt)
      .limit(5);

    // Cast lite projection back to schema row types — only fields read
    // downstream are `promoter.companyName` and `venue.name`, both in
    // the projection. Same pattern as #325/#327/#328.
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    type EventRow = (typeof results)[number];
    return results.map((r: EventRow) => ({
      ...r.events,
      promoter: r.promoter as FullPromoter,
      venue: r.venue as FullVenue,
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching submissions",
      error: e,
      source: "app/admin/page.tsx:getRecentSubmissions",
    });
    return [];
  }
}

async function getUpcomingEventsWithVendorCounts() {
  const db = getCloudflareDb();

  try {
    const now = new Date();

    // Get upcoming approved events. Narrow projection via
    // eventVenueJoinProjection — bare .select() = 62 + 30 = 92 cols, 8
    // cols of headroom below D1's 100 cap. Narrowed = 62 + 7 = 69 cols.
    const upcomingEvents = await db
      .select(eventVenueJoinProjection)
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      // A2 (Dev backlog 2026-06-05): 24h end-of-day grace per upcomingEndPredicate.
      .where(and(eq(events.status, "APPROVED"), upcomingEndPredicate(now)))
      .orderBy(events.startDate)
      .limit(50);

    if (upcomingEvents.length === 0) return [];

    // Get vendor counts for these events
    const vendorCounts = await db
      .select({
        eventId: eventVendors.eventId,
        count: count(),
      })
      .from(eventVendors)
      .where(isPublicVendorStatus())
      .groupBy(eventVendors.eventId);

    const countMap = new Map(vendorCounts.map((vc) => [vc.eventId, vc.count]));

    type FullVenue = typeof venues.$inferSelect;
    return upcomingEvents.map((e) => ({
      ...e.events,
      venue: e.venue as FullVenue | null,
      vendorCount: countMap.get(e.events.id) || 0,
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching upcoming events",
      error: e,
      source: "app/admin/page.tsx:getUpcomingEventsWithVendorCounts",
    });
    return [];
  }
}

export default async function AdminDashboard() {
  const [stats, recentSubmissions, upcomingEvents] = await Promise.all([
    getStats(),
    getRecentSubmissions(),
    getUpcomingEventsWithVendorCounts(),
  ]);

  const statCards = [
    {
      name: "Total Events",
      value: stats.totalEvents,
      icon: Calendar,
      color: "blue",
      href: "/admin/events",
    },
    {
      name: "Pending Approval",
      value: stats.pendingEvents,
      icon: Clock,
      color: "yellow",
      href: "/admin/submissions",
    },
    {
      name: "Venues",
      value: stats.totalVenues,
      icon: MapPin,
      color: "green",
      href: "/admin/venues",
    },
    {
      name: "Vendors",
      value: stats.totalVendors,
      icon: Store,
      color: "purple",
      href: "/admin/vendors",
    },
    {
      name: "Event-Vendor Links",
      value: stats.totalEventVendors,
      icon: UserPlus,
      color: "indigo",
      href: "/admin/events",
    },
    {
      name: "Users",
      value: stats.totalUsers,
      icon: Users,
      color: "gray",
      href: "/admin/users",
    },
    {
      name: "Analytics",
      value: "\u2192" as string | number,
      icon: BarChart3,
      color: "blue",
      href: "/admin/analytics",
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-8">Admin Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {statCards.map((stat) => (
          <Link key={stat.name} href={stat.href}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{stat.name}</p>
                    <p className="text-3xl font-bold text-foreground mt-1">{stat.value}</p>
                  </div>
                  <div
                    className={`w-12 h-12 rounded-lg flex items-center justify-center bg-${stat.color}-100`}
                  >
                    <stat.icon className={`w-6 h-6 text-${stat.color}-600`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Recent Submissions */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-foreground">Recent Submissions</h2>
          </CardHeader>
          <CardContent>
            {recentSubmissions.length === 0 ? (
              <p className="text-muted-foreground py-4">No pending submissions</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentSubmissions.map((event) => (
                  <div key={event.id} className="py-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">{event.name}</p>
                      <p className="text-sm text-muted-foreground">
                        by {event.promoter.companyName} at {event.venue?.name || "TBD"}
                      </p>
                    </div>
                    <Link
                      href={`/admin/submissions?id=${event.id}`}
                      className="text-sm text-royal hover:text-navy font-medium"
                    >
                      Review
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Events - Manage Vendors */}
        <EventVendorsPanel events={upcomingEvents} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Schema.org Sync */}
        <SchemaOrgSyncButton />
      </div>
    </div>
  );
}

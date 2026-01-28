import Link from "next/link";
import { Calendar, MapPin, Store, Users, Megaphone, Clock, UserPlus } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, venues, vendors, promoters, users, eventVendors } from "@/lib/db/schema";
import { eq, count, gte, and } from "drizzle-orm";
import { EventVendorsPanel } from "@/components/admin/event-vendors-panel";

export const runtime = "edge";


async function getStats() {
  try {
    const db = getCloudflareDb();

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
      db.select({ count: count() }).from(eventVendors).where(eq(eventVendors.status, "APPROVED")),
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
    console.error("Error fetching stats:", e);
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
  try {
    const db = getCloudflareDb();

    const results = await db
      .select()
      .from(events)
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.status, "PENDING"))
      .orderBy(events.createdAt)
      .limit(5);

    return results.map((r) => ({
      ...r.events,
      promoter: r.promoters!,
      venue: r.venues!,
    }));
  } catch (e) {
    console.error("Error fetching submissions:", e);
    return [];
  }
}

async function getUpcomingEventsWithVendorCounts() {
  try {
    const db = getCloudflareDb();
    const now = new Date();

    // Get upcoming approved events
    const upcomingEvents = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(and(
        eq(events.status, "APPROVED"),
        gte(events.endDate, now)
      ))
      .orderBy(events.startDate)
      .limit(50);

    if (upcomingEvents.length === 0) return [];

    // Get vendor counts for these events
    const eventIds = upcomingEvents.map(e => e.events.id);
    const vendorCounts = await db
      .select({
        eventId: eventVendors.eventId,
        count: count(),
      })
      .from(eventVendors)
      .where(eq(eventVendors.status, "APPROVED"))
      .groupBy(eventVendors.eventId);

    const countMap = new Map(vendorCounts.map(vc => [vc.eventId, vc.count]));

    return upcomingEvents.map(e => ({
      ...e.events,
      venue: e.venues,
      vendorCount: countMap.get(e.events.id) || 0,
    }));
  } catch (e) {
    console.error("Error fetching upcoming events:", e);
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
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Admin Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {statCards.map((stat) => (
          <Link key={stat.name} href={stat.href}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">{stat.name}</p>
                    <p className="text-3xl font-bold text-gray-900 mt-1">
                      {stat.value}
                    </p>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Submissions */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">
              Recent Submissions
            </h2>
          </CardHeader>
          <CardContent>
            {recentSubmissions.length === 0 ? (
              <p className="text-gray-500 py-4">No pending submissions</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentSubmissions.map((event) => (
                  <div
                    key={event.id}
                    className="py-4 flex items-center justify-between"
                  >
                    <div>
                      <p className="font-medium text-gray-900">{event.name}</p>
                      <p className="text-sm text-gray-500">
                        by {event.promoter.companyName} at {event.venue?.name || "TBD"}
                      </p>
                    </div>
                    <Link
                      href={`/admin/submissions?id=${event.id}`}
                      className="text-sm text-blue-600 hover:text-blue-700 font-medium"
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
    </div>
  );
}

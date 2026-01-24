import { Calendar, MapPin, Store, Users, Megaphone, Clock } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import prisma from "@/lib/prisma";

async function getStats() {
  try {
    const [
      totalEvents,
      pendingEvents,
      totalVenues,
      totalVendors,
      totalPromoters,
      totalUsers,
    ] = await Promise.all([
      prisma.event.count(),
      prisma.event.count({ where: { status: "PENDING" } }),
      prisma.venue.count(),
      prisma.vendor.count(),
      prisma.promoter.count(),
      prisma.user.count(),
    ]);

    return {
      totalEvents,
      pendingEvents,
      totalVenues,
      totalVendors,
      totalPromoters,
      totalUsers,
    };
  } catch {
    return {
      totalEvents: 0,
      pendingEvents: 0,
      totalVenues: 0,
      totalVendors: 0,
      totalPromoters: 0,
      totalUsers: 0,
    };
  }
}

async function getRecentSubmissions() {
  try {
    return await prisma.event.findMany({
      where: { status: "PENDING" },
      include: {
        promoter: true,
        venue: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  } catch {
    return [];
  }
}

export default async function AdminDashboard() {
  const [stats, recentSubmissions] = await Promise.all([
    getStats(),
    getRecentSubmissions(),
  ]);

  const statCards = [
    {
      name: "Total Events",
      value: stats.totalEvents,
      icon: Calendar,
      color: "blue",
    },
    {
      name: "Pending Approval",
      value: stats.pendingEvents,
      icon: Clock,
      color: "yellow",
    },
    {
      name: "Venues",
      value: stats.totalVenues,
      icon: MapPin,
      color: "green",
    },
    {
      name: "Vendors",
      value: stats.totalVendors,
      icon: Store,
      color: "purple",
    },
    {
      name: "Promoters",
      value: stats.totalPromoters,
      icon: Megaphone,
      color: "orange",
    },
    {
      name: "Users",
      value: stats.totalUsers,
      icon: Users,
      color: "gray",
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Admin Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {statCards.map((stat) => (
          <Card key={stat.name}>
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
        ))}
      </div>

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
                      by {event.promoter.companyName} at {event.venue.name}
                    </p>
                  </div>
                  <a
                    href={`/admin/submissions?id=${event.id}`}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    Review
                  </a>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { redirect } from "next/navigation";
import Link from "next/link";
import { Calendar, MapPin, Store } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";

async function getFavorites(userId: string) {
  try {
    const favorites = await prisma.userFavorite.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const eventIds = favorites
      .filter((f) => f.favoritableType === "event")
      .map((f) => f.favoritableId);
    const venueIds = favorites
      .filter((f) => f.favoritableType === "venue")
      .map((f) => f.favoritableId);
    const vendorIds = favorites
      .filter((f) => f.favoritableType === "vendor")
      .map((f) => f.favoritableId);

    const [events, venues, vendors] = await Promise.all([
      eventIds.length > 0
        ? prisma.event.findMany({
            where: { id: { in: eventIds } },
            include: { venue: true },
          })
        : [],
      venueIds.length > 0
        ? prisma.venue.findMany({ where: { id: { in: venueIds } } })
        : [],
      vendorIds.length > 0
        ? prisma.vendor.findMany({ where: { id: { in: vendorIds } } })
        : [],
    ]);

    return { events, venues, vendors, favorites };
  } catch {
    return { events: [], venues: [], vendors: [], favorites: [] };
  }
}

export default async function FavoritesPage() {
  const session = await auth();

  if (!session) {
    redirect("/login?callbackUrl=/dashboard/favorites");
  }

  const { events, venues, vendors } = await getFavorites(session.user.id);
  const totalFavorites = events.length + venues.length + vendors.length;

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">My Favorites</h1>
        <p className="mt-1 text-gray-600">
          {totalFavorites} saved items
        </p>
      </div>

      {totalFavorites === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-gray-500">You haven&apos;t saved any favorites yet.</p>
            <Link
              href="/events"
              className="mt-4 inline-block text-blue-600 hover:text-blue-700 font-medium"
            >
              Browse Events
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {events.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Calendar className="w-5 h-5" />
                Events ({events.length})
              </h2>
              <div className="space-y-3">
                {events.map((event) => (
                  <Link key={event.id} href={`/events/${event.slug}`}>
                    <Card className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-16 h-16 rounded-lg bg-blue-50 flex items-center justify-center">
                          <Calendar className="w-8 h-8 text-blue-600" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-900">
                            {event.name}
                          </h3>
                          <p className="text-sm text-gray-500">
                            {event.venue.name}, {event.venue.city}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {venues.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                Venues ({venues.length})
              </h2>
              <div className="space-y-3">
                {venues.map((venue) => (
                  <Link key={venue.id} href={`/venues/${venue.slug}`}>
                    <Card className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-16 h-16 rounded-lg bg-green-50 flex items-center justify-center">
                          <MapPin className="w-8 h-8 text-green-600" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-900">
                            {venue.name}
                          </h3>
                          <p className="text-sm text-gray-500">
                            {venue.city}, {venue.state}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {vendors.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Store className="w-5 h-5" />
                Vendors ({vendors.length})
              </h2>
              <div className="space-y-3">
                {vendors.map((vendor) => (
                  <Link key={vendor.id} href={`/vendors/${vendor.slug}`}>
                    <Card className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-16 h-16 rounded-lg bg-purple-50 flex items-center justify-center">
                          <Store className="w-8 h-8 text-purple-600" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-900">
                            {vendor.businessName}
                          </h3>
                          <p className="text-sm text-gray-500">
                            {vendor.vendorType}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

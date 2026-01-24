import Link from "next/link";
import { MapPin, Users, Calendar } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import prisma from "@/lib/prisma";
import { parseJsonArray } from "@/types";

async function getVenues() {
  try {
    const venues = await prisma.venue.findMany({
      where: { status: "ACTIVE" },
      include: {
        _count: {
          select: {
            events: { where: { status: "APPROVED", endDate: { gte: new Date() } } },
          },
        },
      },
      orderBy: { name: "asc" },
    });
    return venues;
  } catch {
    return [];
  }
}

export default async function VenuesPage() {
  const venues = await getVenues();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Venues</h1>
        <p className="mt-2 text-gray-600">
          Discover fairgrounds and event spaces hosting upcoming events
        </p>
      </div>

      {venues.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">No venues available at this time.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {venues.map((venue) => {
            const amenities = parseJsonArray(venue.amenities);
            return (
              <Link key={venue.id} href={`/venues/${venue.slug}`}>
                <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
                  <div className="aspect-video relative bg-gray-100">
                    {venue.imageUrl ? (
                      <img
                        src={venue.imageUrl}
                        alt={venue.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
                        <MapPin className="w-12 h-12" />
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <h3 className="font-semibold text-lg text-gray-900">
                      {venue.name}
                    </h3>
                    <div className="mt-2 space-y-1 text-sm text-gray-600">
                      <div className="flex items-center">
                        <MapPin className="w-4 h-4 mr-2 flex-shrink-0" />
                        <span>
                          {venue.city}, {venue.state}
                        </span>
                      </div>
                      {venue.capacity && (
                        <div className="flex items-center">
                          <Users className="w-4 h-4 mr-2 flex-shrink-0" />
                          <span>Capacity: {venue.capacity.toLocaleString()}</span>
                        </div>
                      )}
                      <div className="flex items-center">
                        <Calendar className="w-4 h-4 mr-2 flex-shrink-0" />
                        <span>{venue._count.events} upcoming events</span>
                      </div>
                    </div>
                    {amenities.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {amenities.slice(0, 3).map((amenity) => (
                          <Badge key={amenity} variant="default">
                            {amenity}
                          </Badge>
                        ))}
                        {amenities.length > 3 && (
                          <Badge variant="default">
                            +{amenities.length - 3}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

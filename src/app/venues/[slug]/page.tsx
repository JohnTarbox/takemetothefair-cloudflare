import { notFound } from "next/navigation";
import Link from "next/link";
import { MapPin, Phone, Mail, Globe, Users, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EventList } from "@/components/events/event-list";
import prisma from "@/lib/prisma";
import { parseJsonArray } from "@/types";
import type { Metadata } from "next";

interface Props {
  params: Promise<{ slug: string }>;
}

async function getVenue(slug: string) {
  try {
    return await prisma.venue.findUnique({
      where: { slug, status: "ACTIVE" },
      include: {
        events: {
          where: { status: "APPROVED", endDate: { gte: new Date() } },
          include: { venue: true, promoter: true },
          orderBy: { startDate: "asc" },
          take: 6,
        },
      },
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const venue = await getVenue(slug);

  if (!venue) {
    return { title: "Venue Not Found" };
  }

  return {
    title: `${venue.name} | Meet Me at the Fair`,
    description: venue.description?.slice(0, 160) || `${venue.name} in ${venue.city}, ${venue.state}`,
  };
}

export default async function VenueDetailPage({ params }: Props) {
  const { slug } = await params;
  const venue = await getVenue(slug);

  if (!venue) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <main className="lg:col-span-2 space-y-6">
          {venue.imageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden bg-gray-100">
              <img
                src={venue.imageUrl}
                alt={venue.name}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900">
              {venue.name}
            </h1>
            <p className="mt-2 text-lg text-gray-600 flex items-center gap-2">
              <MapPin className="w-5 h-5" />
              {venue.city}, {venue.state}
            </p>
          </div>

          {venue.description && (
            <div className="prose prose-gray max-w-none">
              <p className="text-gray-600 whitespace-pre-wrap">
                {venue.description}
              </p>
            </div>
          )}

          {(() => {
            const amenities = parseJsonArray(venue.amenities);
            return amenities.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-3">
                  Amenities
                </h2>
                <div className="flex flex-wrap gap-2">
                  {amenities.map((amenity) => (
                    <Badge key={amenity} variant="info">
                      {amenity}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })()}

          {venue.events.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-900">
                  Upcoming Events
                </h2>
                <Link
                  href={`/events?venue=${venue.slug}`}
                  className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                >
                  View All
                </Link>
              </div>
              <EventList events={venue.events} />
            </div>
          )}
        </main>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <h3 className="font-semibold text-gray-900">Location</h3>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-3">
                <MapPin className="w-5 h-5 text-blue-600 mt-0.5" />
                <div>
                  <p className="text-gray-900">{venue.address}</p>
                  <p className="text-gray-600">
                    {venue.city}, {venue.state} {venue.zip}
                  </p>
                </div>
              </div>
              {venue.capacity && (
                <div className="flex items-center gap-3">
                  <Users className="w-5 h-5 text-blue-600" />
                  <p className="text-gray-900">
                    Capacity: {venue.capacity.toLocaleString()}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h3 className="font-semibold text-gray-900">Contact</h3>
            </CardHeader>
            <CardContent className="space-y-3">
              {venue.contactPhone && (
                <a
                  href={`tel:${venue.contactPhone}`}
                  className="flex items-center gap-3 text-gray-700 hover:text-blue-600"
                >
                  <Phone className="w-5 h-5 text-blue-600" />
                  {venue.contactPhone}
                </a>
              )}
              {venue.contactEmail && (
                <a
                  href={`mailto:${venue.contactEmail}`}
                  className="flex items-center gap-3 text-gray-700 hover:text-blue-600"
                >
                  <Mail className="w-5 h-5 text-blue-600" />
                  {venue.contactEmail}
                </a>
              )}
              {venue.website && (
                <a
                  href={venue.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 text-gray-700 hover:text-blue-600"
                >
                  <Globe className="w-5 h-5 text-blue-600" />
                  Visit Website
                </a>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-3">
                <Calendar className="w-8 h-8 text-blue-600" />
                <div>
                  <p className="text-2xl font-bold text-gray-900">
                    {venue.events.length}
                  </p>
                  <p className="text-sm text-gray-600">Upcoming Events</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

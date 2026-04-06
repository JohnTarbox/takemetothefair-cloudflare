import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  MapPin,
  Phone,
  Mail,
  Globe,
  Users,
  Calendar,
  ExternalLink,
  Pencil,
  Accessibility,
  ParkingSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EventList } from "@/components/events/event-list";
import { getCloudflareDb } from "@/lib/cloudflare";
import { venues, events, promoters } from "@/lib/db/schema";
import { eq, and, gte } from "drizzle-orm";
import { isPublicEventStatus } from "@/lib/event-status";
import { parseJsonArray } from "@/types";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import { logError } from "@/lib/logger";
import { buildVenueMetaDescription } from "@/lib/seo-utils";
import { VenueSchema } from "@/components/seo/VenueSchema";
import { BreadcrumbSchema } from "@/components/seo/BreadcrumbSchema";
import { DetailPageTracker } from "@/components/DetailPageTracker";
import { ScrollDepthTracker } from "@/components/ScrollDepthTracker";

export const runtime = "edge";
export const revalidate = 300; // Cache for 5 minutes

interface Props {
  params: Promise<{ slug: string }>;
}

async function getVenue(slug: string) {
  const db = getCloudflareDb();

  try {
    // Get venue
    const venueResults = await db
      .select()
      .from(venues)
      .where(and(eq(venues.slug, slug), eq(venues.status, "ACTIVE")))
      .limit(1);

    if (venueResults.length === 0) return null;

    const venue = venueResults[0];

    // Get upcoming events for this venue
    const eventResults = await db
      .select()
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .where(
        and(eq(events.venueId, venue.id), isPublicEventStatus(), gte(events.endDate, new Date()))
      )
      .orderBy(events.startDate)
      .limit(6);

    const venueEvents = eventResults.map((r) => ({
      ...r.events,
      venue: r.venues!,
      promoter: r.promoters!,
    }));

    return {
      ...venue,
      events: venueEvents,
    };
  } catch (e) {
    await logError(db, {
      message: "Error fetching venue",
      error: e,
      source: "app/venues/[slug]/page.tsx:getVenue",
      context: { slug },
    });
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const venue = await getVenue(slug);

  if (!venue) {
    return { title: "Venue Not Found" };
  }

  const title = `${venue.name} | Meet Me at the Fair`;
  const description = buildVenueMetaDescription(venue);
  const url = `https://meetmeatthefair.com/venues/${venue.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: venue.name,
      description,
      url,
      siteName: "Meet Me at the Fair",
      type: "website",
      images: [
        {
          url: venue.imageUrl || "https://meetmeatthefair.com/og-default.png",
          width: 1200,
          height: 630,
          alt: venue.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: venue.name,
      description,
      images: [venue.imageUrl || "https://meetmeatthefair.com/og-default.png"],
    },
  };
}

export default async function VenueDetailPage({ params }: Props) {
  const { slug } = await params;
  const venue = await getVenue(slug);

  if (!venue) {
    notFound();
  }

  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";

  const amenities = parseJsonArray(venue.amenities);

  return (
    <>
      <DetailPageTracker type="venue" slug={venue.slug} name={venue.name} />
      <ScrollDepthTracker pageType="venue-detail" />
      <VenueSchema
        name={venue.name}
        description={venue.description}
        imageUrl={venue.imageUrl}
        url={`https://meetmeatthefair.com/venues/${venue.slug}`}
        address={venue.address}
        city={venue.city}
        state={venue.state}
        zip={venue.zip}
        latitude={venue.latitude}
        longitude={venue.longitude}
        capacity={venue.capacity}
        telephone={venue.contactPhone}
        amenities={amenities}
        googleRating={venue.googleRating}
        googleRatingCount={venue.googleRatingCount}
        openingHours={venue.openingHours}
        accessibility={parseJsonArray(venue.accessibility)}
        website={venue.website}
        upcomingEvents={venue.events.map((e) => ({
          name: e.name,
          url: `https://meetmeatthefair.com/events/${e.slug}`,
          startDate: e.startDate!,
          endDate: e.endDate!,
        }))}
      />
      <BreadcrumbSchema
        items={[
          { name: "Home", url: "https://meetmeatthefair.com" },
          { name: "Venues", url: "https://meetmeatthefair.com/venues" },
          { name: venue.name, url: `https://meetmeatthefair.com/venues/${venue.slug}` },
        ]}
      />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <main className="lg:col-span-2 space-y-6">
            {venue.imageUrl && (
              <div className="aspect-video rounded-xl overflow-hidden bg-gray-100 relative">
                <Image
                  src={venue.imageUrl}
                  alt={venue.name}
                  fill
                  priority
                  sizes="(max-width: 1024px) 100vw, 66vw"
                  className="object-cover"
                />
              </div>
            )}

            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-gray-900">{venue.name}</h1>
              <p className="mt-2 text-lg text-gray-600 flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                {venue.city}, {venue.state}
              </p>
            </div>

            {venue.description && (
              <div className="prose prose-gray max-w-none">
                <p className="text-gray-600 whitespace-pre-wrap">{venue.description}</p>
              </div>
            )}

            {(() => {
              return (
                amenities.length > 0 && (
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 mb-3">Amenities</h2>
                    <div className="flex flex-wrap gap-2">
                      {amenities.map((amenity) => (
                        <Badge key={amenity} variant="info">
                          {amenity}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )
              );
            })()}

            {(() => {
              if (!venue.accessibility) return null;
              const LABELS: Record<string, string> = {
                wheelchairAccessibleParking: "Wheelchair accessible parking",
                wheelchairAccessibleEntrance: "Wheelchair accessible entrance",
                wheelchairAccessibleRestroom: "Wheelchair accessible restroom",
                wheelchairAccessibleSeating: "Wheelchair accessible seating",
              };
              try {
                const data = JSON.parse(venue.accessibility);
                const features = Object.entries(data)
                  .filter(([, v]) => v === true)
                  .map(([k]) => LABELS[k] || k.replace(/([A-Z])/g, " $1").trim());
                if (features.length === 0) return null;
                return (
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 mb-3 flex items-center gap-2">
                      <Accessibility className="w-5 h-5" />
                      Accessibility
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {features.map((feature) => (
                        <Badge key={feature} variant="info">
                          {feature}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              } catch {
                return null;
              }
            })()}

            {(() => {
              if (!venue.parking) return null;
              const LABELS: Record<string, string> = {
                freeParkingLot: "Free parking lot",
                paidParkingLot: "Paid parking lot",
                freeStreetParking: "Free street parking",
                paidStreetParking: "Paid street parking",
                valetParking: "Valet parking",
                freeGarageParking: "Free garage parking",
                paidGarageParking: "Paid garage parking",
              };
              try {
                const data = JSON.parse(venue.parking);
                const options = Object.entries(data)
                  .filter(([, v]) => v === true)
                  .map(([k]) => LABELS[k] || k.replace(/([A-Z])/g, " $1").trim());
                if (options.length === 0) return null;
                return (
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900 mb-3 flex items-center gap-2">
                      <ParkingSquare className="w-5 h-5" />
                      Parking
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {options.map((option) => (
                        <Badge key={option} variant="info">
                          {option}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              } catch {
                return null;
              }
            })()}

            {venue.events.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-gray-900">Upcoming Events</h2>
                  <Link
                    href={`/events?venue=${venue.slug}`}
                    className="text-royal hover:text-navy text-sm font-medium"
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
                  <MapPin className="w-5 h-5 text-royal mt-0.5" />
                  <div>
                    <p className="text-gray-900">{venue.address}</p>
                    <p className="text-gray-600">
                      {venue.city}, {venue.state} {venue.zip}
                    </p>
                    <a
                      href={
                        venue.googleMapsUrl ||
                        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${venue.address}, ${venue.city}, ${venue.state} ${venue.zip}`)}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-royal hover:text-navy mt-2"
                    >
                      <ExternalLink className="w-4 h-4" />
                      View on Google Maps
                    </a>
                  </div>
                </div>
                {venue.capacity && (
                  <div className="flex items-center gap-3">
                    <Users className="w-5 h-5 text-royal" />
                    <p className="text-gray-900">Capacity: {venue.capacity.toLocaleString()}</p>
                  </div>
                )}
                {isAdmin && (
                  <Link href={`/admin/venues/${venue.id}/edit`}>
                    <Button variant="outline" className="w-full mt-3">
                      <Pencil className="w-4 h-4 mr-2" />
                      Edit Venue
                    </Button>
                  </Link>
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
                    className="flex items-center gap-3 text-gray-700 hover:text-royal"
                  >
                    <Phone className="w-5 h-5 text-royal" />
                    {venue.contactPhone}
                  </a>
                )}
                {venue.contactEmail && (
                  <a
                    href={`mailto:${venue.contactEmail}`}
                    className="flex items-center gap-3 text-gray-700 hover:text-royal"
                  >
                    <Mail className="w-5 h-5 text-royal" />
                    {venue.contactEmail}
                  </a>
                )}
                {venue.website && (
                  <a
                    href={venue.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 text-gray-700 hover:text-royal"
                  >
                    <Globe className="w-5 h-5 text-royal" />
                    Visit Website
                  </a>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center gap-3">
                  <Calendar className="w-8 h-8 text-royal" />
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{venue.events.length}</p>
                    <p className="text-sm text-gray-600">Upcoming Events</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </>
  );
}

import { notFound } from "next/navigation";
import Link from "next/link";
import { Store, Globe, CheckCircle, Calendar, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDateRange } from "@/lib/utils";
import prisma from "@/lib/prisma";
import { parseJsonArray } from "@/types";
import type { Metadata } from "next";

interface Props {
  params: Promise<{ slug: string }>;
}

async function getVendor(slug: string) {
  try {
    return await prisma.vendor.findUnique({
      where: { slug },
      include: {
        user: { select: { name: true, email: true } },
        eventVendors: {
          where: { status: "APPROVED" },
          include: {
            event: {
              include: { venue: true },
            },
          },
          orderBy: { event: { startDate: "asc" } },
        },
      },
    });
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const vendor = await getVendor(slug);

  if (!vendor) {
    return { title: "Vendor Not Found" };
  }

  return {
    title: `${vendor.businessName} | Meet Me at the Fair`,
    description: vendor.description?.slice(0, 160) || `${vendor.businessName} - ${vendor.vendorType}`,
  };
}

export default async function VendorDetailPage({ params }: Props) {
  const { slug } = await params;
  const vendor = await getVendor(slug);

  if (!vendor) {
    notFound();
  }

  const upcomingEvents = vendor.eventVendors.filter(
    (ev) => new Date(ev.event.endDate) >= new Date()
  );
  const pastEvents = vendor.eventVendors.filter(
    (ev) => new Date(ev.event.endDate) < new Date()
  );

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <main className="lg:col-span-2 space-y-6">
          <div className="flex items-start gap-6">
            <div className="w-24 h-24 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
              {vendor.logoUrl ? (
                <img
                  src={vendor.logoUrl}
                  alt={vendor.businessName}
                  className="w-24 h-24 rounded-xl object-cover"
                />
              ) : (
                <Store className="w-12 h-12 text-gray-400" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold text-gray-900">
                  {vendor.businessName}
                </h1>
                {vendor.verified && (
                  <CheckCircle className="w-6 h-6 text-blue-600" />
                )}
              </div>
              {vendor.vendorType && (
                <p className="mt-1 text-lg text-gray-600">{vendor.vendorType}</p>
              )}
            </div>
          </div>

          {vendor.description && (
            <div className="prose prose-gray max-w-none">
              <p className="text-gray-600 whitespace-pre-wrap">
                {vendor.description}
              </p>
            </div>
          )}

          {(() => {
            const products = parseJsonArray(vendor.products);
            return products.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-3">
                  Products & Services
                </h2>
                <div className="flex flex-wrap gap-2">
                  {products.map((product) => (
                    <Badge key={product} variant="info">
                      {product}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })()}

          {upcomingEvents.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                Upcoming Events
              </h2>
              <div className="space-y-3">
                {upcomingEvents.map(({ event }) => (
                  <Link key={event.id} href={`/events/${event.slug}`}>
                    <Card className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-16 h-16 rounded-lg bg-blue-50 flex flex-col items-center justify-center text-blue-600">
                          <Calendar className="w-6 h-6" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-900">
                            {event.name}
                          </h3>
                          <p className="text-sm text-gray-600">
                            {formatDateRange(event.startDate, event.endDate)}
                          </p>
                          <p className="text-sm text-gray-500 flex items-center gap-1 mt-1">
                            <MapPin className="w-3 h-3" />
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

          {pastEvents.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                Past Events
              </h2>
              <div className="space-y-3">
                {pastEvents.slice(0, 5).map(({ event }) => (
                  <Link key={event.id} href={`/events/${event.slug}`}>
                    <Card className="hover:shadow-md transition-shadow opacity-75">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="w-16 h-16 rounded-lg bg-gray-100 flex flex-col items-center justify-center text-gray-400">
                          <Calendar className="w-6 h-6" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-700">
                            {event.name}
                          </h3>
                          <p className="text-sm text-gray-500">
                            {formatDateRange(event.startDate, event.endDate)}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </main>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <h3 className="font-semibold text-gray-900">Contact & Links</h3>
            </CardHeader>
            <CardContent className="space-y-3">
              {vendor.website && (
                <a
                  href={vendor.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 text-gray-700 hover:text-blue-600"
                >
                  <Globe className="w-5 h-5 text-blue-600" />
                  Visit Website
                </a>
              )}
              {vendor.socialLinks &&
                typeof vendor.socialLinks === "object" &&
                Object.entries(vendor.socialLinks as Record<string, string>).map(
                  ([platform, url]) => (
                    <a
                      key={platform}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 text-gray-700 hover:text-blue-600 capitalize"
                    >
                      {platform}
                    </a>
                  )
                )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="text-center">
                <p className="text-3xl font-bold text-gray-900">
                  {vendor.eventVendors.length}
                </p>
                <p className="text-sm text-gray-600">Total Events Attended</p>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

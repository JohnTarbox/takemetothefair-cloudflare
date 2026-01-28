"use client";

import Link from "next/link";
import Image from "next/image";
import { Store, CheckCircle, Calendar, MapPin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parseJsonArray } from "@/types";
import { formatDateRange } from "@/lib/utils";
import { FavoriteButton } from "@/components/FavoriteButton";

interface VendorEvent {
  id: string;
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
  imageUrl: string | null;
  venue: {
    name: string;
    city: string | null;
    state: string | null;
  } | null;
}

interface VendorCardProps {
  vendor: {
    id: string;
    businessName: string;
    slug: string;
    description: string | null;
    vendorType: string | null;
    products: string | null;
    logoUrl: string | null;
    verified: boolean | null;
    commercial: boolean | null;
    city?: string | null;
    state?: string | null;
    events: VendorEvent[];
  };
}

export function VendorCard({ vendor }: VendorCardProps) {
  const products = parseJsonArray(vendor.products);

  return (
    <Card className="overflow-hidden">
      <div className="p-6">
        <div className="flex gap-4">
          <Link href={`/vendors/${vendor.slug}`} className="flex-shrink-0">
            <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center relative overflow-hidden hover:opacity-80 transition-opacity">
              {vendor.logoUrl ? (
                <Image
                  src={vendor.logoUrl}
                  alt={vendor.businessName}
                  fill
                  sizes="64px"
                  className="object-cover"
                />
              ) : (
                <Store className="w-8 h-8 text-gray-400" />
              )}
            </div>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/vendors/${vendor.slug}`} className="hover:text-blue-600">
                <h3 className="font-semibold text-gray-900 truncate">
                  {vendor.businessName}
                </h3>
              </Link>
              {vendor.verified && (
                <CheckCircle className="w-4 h-4 text-blue-600 flex-shrink-0" />
              )}
              {vendor.commercial && (
                <Badge variant="default">Commercial</Badge>
              )}
              <FavoriteButton
                type="VENDOR"
                id={vendor.id}
                className="ml-auto"
                size="sm"
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500 mt-1">
              {vendor.vendorType && (
                <span>{vendor.vendorType}</span>
              )}
              {vendor.vendorType && (vendor.city || vendor.state) && (
                <span>•</span>
              )}
              {(vendor.city || vendor.state) && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {[vendor.city, vendor.state].filter(Boolean).join(", ")}
                </span>
              )}
            </div>
            {vendor.description && (
              <p className="text-sm text-gray-600 mt-2 line-clamp-2">
                {vendor.description}
              </p>
            )}
            {products.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {products.slice(0, 3).map((product) => (
                  <Badge key={product} variant="default">
                    {product}
                  </Badge>
                ))}
                {products.length > 3 && (
                  <Badge variant="default">+{products.length - 3}</Badge>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Events Grid */}
        {vendor.events.length > 0 && (
          <div className="mt-6 pt-6 border-t border-gray-100">
            <h4 className="text-sm font-medium text-gray-900 mb-3 flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Upcoming Events ({vendor.events.length})
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {vendor.events.map((event) => (
                <Link
                  key={event.id}
                  href={`/events/${event.slug}`}
                  className="block p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  {event.imageUrl && (
                    <div className="aspect-video rounded-md overflow-hidden mb-2 relative">
                      <Image
                        src={event.imageUrl}
                        alt={event.name}
                        fill
                        sizes="(max-width: 640px) 100vw, 200px"
                        className="object-cover"
                      />
                    </div>
                  )}
                  <p className="font-medium text-gray-900 text-sm truncate">
                    {event.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {formatDateRange(event.startDate, event.endDate)}
                  </p>
                  {event.venue && (
                    <p className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                      <MapPin className="w-3 h-3" />
                      {event.venue.city}, {event.venue.state}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {vendor.events.length === 0 && (
          <p className="mt-4 text-xs text-gray-500">
            No upcoming events scheduled
          </p>
        )}
      </div>
    </Card>
  );
}

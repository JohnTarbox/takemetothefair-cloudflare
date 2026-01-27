"use client";

import Link from "next/link";
import { Calendar, MapPin, Tag, Store } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange, formatPrice } from "@/lib/utils";
import { parseJsonArray } from "@/types";
import type { events, venues, promoters } from "@/lib/db/schema";
import { AddToCalendar } from "./AddToCalendar";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

type VendorSummary = {
  id: string;
  businessName: string;
  slug: string;
  logoUrl: string | null;
  vendorType: string | null;
};

interface EventCardProps {
  event: Event & {
    venue: Venue | null;
    promoter: Promoter | null;
    vendors?: VendorSummary[];
  };
}

export function EventCard({ event }: EventCardProps) {
  const categories = parseJsonArray(event.categories);
  const vendors = event.vendors || [];

  return (
    <Card className="h-full hover:shadow-md transition-shadow">
      <Link href={`/events/${event.slug}`} className="block">
        <div className="aspect-video relative bg-gray-100">
          {event.imageUrl ? (
            <img
              src={event.imageUrl}
              alt={event.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <Calendar className="w-12 h-12" />
            </div>
          )}
          {event.featured && (
            <Badge variant="warning" className="absolute top-3 left-3">
              Featured
            </Badge>
          )}
        </div>
        <div className="p-4">
          <h3 className="font-semibold text-lg text-gray-900 line-clamp-2">
            {event.name}
          </h3>
          <div className="mt-2 space-y-1 text-sm text-gray-600">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Calendar className="w-4 h-4 mr-2 flex-shrink-0" />
                <span>{formatDateRange(event.startDate, event.endDate)}</span>
              </div>
              <AddToCalendar
                title={event.name}
                description={event.description || undefined}
                location={event.venue ? `${event.venue.name}, ${event.venue.address}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip}` : undefined}
                startDate={event.startDate}
                endDate={event.endDate}
                url={`https://meetmeatthefair.com/events/${event.slug}`}
                variant="icon"
              />
            </div>
            {event.venue && (
              <div className="flex items-center">
                <MapPin className="w-4 h-4 mr-2 flex-shrink-0" />
                <span className="truncate">
                  {event.venue.name}, {event.venue.city}, {event.venue.state}
                </span>
              </div>
            )}
            {event.ticketPriceMin !== null && (
              <div className="flex items-center">
                <Tag className="w-4 h-4 mr-2 flex-shrink-0" />
                <span>
                  {formatPrice(event.ticketPriceMin, event.ticketPriceMax)}
                </span>
              </div>
            )}
          </div>
          {categories.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {categories.slice(0, 3).map((category) => (
                <Badge key={category} variant="default">
                  {category}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </Link>

      {/* Vendors Grid */}
      {vendors.length > 0 && (
        <div className="px-4 pb-4 pt-2 border-t border-gray-100">
          <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
            <Store className="w-3 h-3" />
            Vendors ({vendors.length})
          </p>
          <div className="grid grid-cols-4 gap-1">
            {vendors.slice(0, 8).map((vendor) => (
              <Link
                key={vendor.id}
                href={`/vendors/${vendor.slug}`}
                className="block group"
                title={vendor.businessName}
              >
                <div className="aspect-square rounded bg-gray-100 flex items-center justify-center overflow-hidden group-hover:ring-2 ring-blue-500 transition-all">
                  {vendor.logoUrl ? (
                    <img
                      src={vendor.logoUrl}
                      alt={vendor.businessName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Store className="w-4 h-4 text-gray-400" />
                  )}
                </div>
              </Link>
            ))}
            {vendors.length > 8 && (
              <Link
                href={`/events/${event.slug}`}
                className="aspect-square rounded bg-gray-100 flex items-center justify-center text-xs text-gray-500 hover:bg-gray-200 transition-colors"
              >
                +{vendors.length - 8}
              </Link>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

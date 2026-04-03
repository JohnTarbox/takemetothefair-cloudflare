"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Calendar, MapPin, Tag, Store } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange, formatPrice } from "@/lib/utils";
import { parseJsonArray } from "@/types";
import type { events, venues, promoters } from "@/lib/db/schema";
import { AddToCalendar } from "./AddToCalendar";
import { FavoriteButton } from "@/components/FavoriteButton";
import { getCategoryColors, getCategoryBadgeClass } from "@/lib/category-colors";

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
  /** Set to true for above-the-fold images to enable priority loading */
  priority?: boolean;
}

export function EventCard({ event, priority = false }: EventCardProps) {
  const [imgError, setImgError] = useState(false);
  const categories = parseJsonArray(event.categories);
  const vendors = event.vendors || [];
  const colors = getCategoryColors(categories);

  // Parse start date for date badge
  const startDate = event.startDate ? new Date(event.startDate) : null;
  const monthAbbr = startDate
    ? startDate.toLocaleDateString("en-US", { month: "short" }).toUpperCase()
    : null;
  const dayNum = startDate ? startDate.getDate() : null;

  return (
    <Card className="h-full hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden">
      {/* Top accent bar */}
      <div className={`h-1 ${colors.bg.replace("-50", "-400").replace("-100", "-500")}`} style={{ backgroundColor: colors.icon.includes("blue") ? "#3B6FD4" : colors.icon.includes("purple") ? "#9333ea" : colors.icon.includes("amber") ? "#E8960C" : colors.icon.includes("green") ? "#16a34a" : colors.icon.includes("emerald") ? "#059669" : "#9ca3af" }} />
      <Link href={`/events/${event.slug}`} className="block">
        <div className={`aspect-video relative ${event.imageUrl && !imgError ? "bg-gray-100" : colors.bg}`}>
          {event.imageUrl && !imgError ? (
            <Image
              src={event.imageUrl}
              alt={`Photo of ${event.name} event`}
              fill
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              className="object-cover"
              priority={priority}
              onError={() => setImgError(true)}
            />
          ) : (
            <div className={`w-full h-full flex items-center justify-center ${colors.icon}`}>
              <Calendar className="w-12 h-12" />
            </div>
          )}
          {/* Date badge */}
          {monthAbbr && dayNum && (!event.imageUrl || imgError) && (
            <div className="absolute bottom-3 left-3 bg-white rounded-lg shadow-sm px-2.5 py-1.5 text-center leading-tight">
              <div className="text-[10px] font-semibold text-amber tracking-wide">{monthAbbr}</div>
              <div className="text-lg font-bold text-navy -mt-0.5">{dayNum}</div>
            </div>
          )}
          <div className="absolute top-3 left-3 flex gap-1">
            {event.featured && (
              <Badge variant="warning">
                Featured
              </Badge>
            )}
            {event.status === "TENTATIVE" && (
              <Badge variant="info">
                Tentative
              </Badge>
            )}
          </div>
          <FavoriteButton
            type="EVENT"
            id={event.id}
            className="absolute top-3 right-3 z-10"
            size="sm"
          />
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
                <Badge key={category} className={getCategoryBadgeClass(category)}>
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
                <div className="aspect-square rounded bg-gray-100 flex items-center justify-center overflow-hidden group-hover:ring-2 ring-royal transition-all relative">
                  {vendor.logoUrl ? (
                    <Image
                      src={vendor.logoUrl}
                      alt={`${vendor.businessName} logo`}
                      fill
                      sizes="48px"
                      className="object-cover"
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

import Link from "next/link";
import { Calendar, MapPin, Tag } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange, formatPrice } from "@/lib/utils";
import { parseJsonArray } from "@/types";
import type { events, venues, promoters } from "@/lib/db/schema";

type Event = typeof events.$inferSelect;
type Venue = typeof venues.$inferSelect;
type Promoter = typeof promoters.$inferSelect;

interface EventCardProps {
  event: Event & {
    venue: Venue;
    promoter: Promoter;
  };
}

export function EventCard({ event }: EventCardProps) {
  const categories = parseJsonArray(event.categories);

  return (
    <Link href={`/events/${event.slug}`}>
      <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
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
            <div className="flex items-center">
              <Calendar className="w-4 h-4 mr-2 flex-shrink-0" />
              <span>{formatDateRange(event.startDate, event.endDate)}</span>
            </div>
            <div className="flex items-center">
              <MapPin className="w-4 h-4 mr-2 flex-shrink-0" />
              <span className="truncate">
                {event.venue.name}, {event.venue.city}, {event.venue.state}
              </span>
            </div>
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
      </Card>
    </Link>
  );
}

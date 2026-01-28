"use client";

import Link from "next/link";
import Image from "next/image";
import { MapPin, Users, Calendar } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parseJsonArray } from "@/types";
import { FavoriteButton } from "@/components/FavoriteButton";

interface VenueCardProps {
  venue: {
    id: string;
    name: string;
    slug: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    capacity: number | null;
    amenities: string | null;
    imageUrl: string | null;
    _count: {
      events: number;
    };
  };
}

export function VenueCard({ venue }: VenueCardProps) {
  const amenities = parseJsonArray(venue.amenities);

  return (
    <Card className="h-full hover:shadow-md transition-shadow">
      <Link href={`/venues/${venue.slug}`} className="block">
        <div className="aspect-video relative bg-gray-100">
          {venue.imageUrl ? (
            <Image
              src={venue.imageUrl}
              alt={venue.name}
              fill
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              className="object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <MapPin className="w-12 h-12" />
            </div>
          )}
          <FavoriteButton
            type="VENUE"
            id={venue.id}
            className="absolute top-3 right-3 z-10"
            size="sm"
          />
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
      </Link>
    </Card>
  );
}

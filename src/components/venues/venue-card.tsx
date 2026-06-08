"use client";

import { useState } from "react";
import Link from "next/link";
import { MapPin, Users, Calendar } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parseJsonArray } from "@/types";
import { pluralize } from "@/lib/text";
import { FavoriteButton } from "@/components/FavoriteButton";
import { getStateColors } from "@/lib/state-colors";
import { displayVenueName } from "@/lib/venue-display";
import { cdnImage, focalPointGravity } from "@/lib/cdn-image";

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
    imageFocalX?: number;
    imageFocalY?: number;
    _count: {
      events: number;
    };
  };
  /**
   * Set to true for the SINGLE LCP candidate per page only. Emits
   * `<link rel="preload" as="image">`. Multiple priority cards
   * compete and the browser deprioritizes them — see EventCard docs.
   */
  priority?: boolean;
}

export function VenueCard({ venue, priority = false }: VenueCardProps) {
  const [imgError, setImgError] = useState(false);
  const amenities = parseJsonArray(venue.amenities);

  // Build full address string
  const formatAddress = () => {
    const parts: string[] = [];
    if (venue.address) parts.push(venue.address);

    const cityStateZip: string[] = [];
    if (venue.city) cityStateZip.push(venue.city);
    if (venue.state) cityStateZip.push(venue.state);
    if (venue.zip) cityStateZip.push(venue.zip);

    if (cityStateZip.length > 0) {
      // Format as "City, State Zip"
      if (venue.city && venue.state) {
        parts.push(`${venue.city}, ${venue.state}${venue.zip ? ` ${venue.zip}` : ""}`);
      } else {
        parts.push(cityStateZip.join(", "));
      }
    }

    return parts.length > 0 ? parts : null;
  };

  const addressParts = formatAddress();

  const stateColors = getStateColors(venue.state);

  return (
    <Card className="h-full hover:shadow-md hover:-translate-y-0.5 transition-all">
      <Link href={`/venues/${venue.slug}`} className="block">
        <div
          className={`aspect-video relative ${venue.imageUrl && !imgError ? "bg-muted" : stateColors.bg}`}
        >
          {venue.imageUrl && !imgError ? (
            // IMG1 §1b Phase 1 (2026-06-08) — same skill pattern as
            // EventCard (PR #394): server-side fit=cover at the right
            // size + per-image focal point. Reads venue.imageFocalX/Y
            // (default 0.5 = center). See event-card.tsx for the full
            // explanation of the architecture choice.
            (() => {
              const gravity = focalPointGravity(venue.imageFocalX, venue.imageFocalY);
              const cardWidths = [400, 600, 800, 1200];
              const cardSrcSet = cardWidths
                .map((w) =>
                  cdnImage(venue.imageUrl!, {
                    width: w,
                    height: Math.round((w * 9) / 16),
                    fit: "cover",
                    ...(gravity ? { gravity } : {}),
                    format: "auto",
                    quality: 80,
                    onerror: "redirect",
                  })
                )
                .map((url, i) => `${url} ${cardWidths[i]}w`)
                .join(", ");
              const cardSrc = cdnImage(venue.imageUrl, {
                width: 800,
                height: 450,
                fit: "cover",
                ...(gravity ? { gravity } : {}),
                format: "auto",
                quality: 80,
                onerror: "redirect",
              });
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={cardSrc}
                  srcSet={cardSrcSet}
                  sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                  alt={`Photo of ${venue.name} venue`}
                  width={800}
                  height={450}
                  loading={priority ? "eager" : "lazy"}
                  fetchPriority={priority ? "high" : "auto"}
                  decoding="async"
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={() => setImgError(true)}
                />
              );
            })()
          ) : (
            <div className={`w-full h-full flex items-center justify-center ${stateColors.icon}`}>
              <MapPin className="w-12 h-12" />
            </div>
          )}
          {venue.state && (!venue.imageUrl || imgError) && (
            <div className="absolute top-3 left-3">
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${stateColors.badge}`}
              >
                {venue.state}
              </span>
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
          <h3 className="font-semibold text-lg text-foreground">
            {/* Cohort 8 (C9/U9) — fall back when venue.name looks like
                a street address (created via URL import that copied the
                address into the name field). Data-cleanup rule in
                src/lib/recommendations/rules/venues-named-by-address.ts. */}
            {displayVenueName(venue)}
          </h3>
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            {addressParts && (
              <div className="flex items-start">
                <MapPin className="w-4 h-4 mr-2 flex-shrink-0 mt-0.5" />
                <div>
                  {addressParts.map((part, i) => (
                    <div key={i}>{part}</div>
                  ))}
                </div>
              </div>
            )}
            {venue.capacity && (
              <div className="flex items-center">
                <Users className="w-4 h-4 mr-2 flex-shrink-0" />
                <span>Capacity: {venue.capacity.toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center">
              <Calendar className="w-4 h-4 mr-2 flex-shrink-0" />
              <span>{pluralize(venue._count.events, "upcoming event")}</span>
            </div>
          </div>
          {amenities.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {amenities.slice(0, 3).map((amenity) => (
                <Badge key={amenity} variant="default">
                  {amenity}
                </Badge>
              ))}
              {amenities.length > 3 && <Badge variant="default">+{amenities.length - 3}</Badge>}
            </div>
          )}
        </div>
      </Link>
    </Card>
  );
}

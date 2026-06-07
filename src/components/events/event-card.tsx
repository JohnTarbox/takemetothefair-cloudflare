"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Calendar, MapPin, Tag, Store, Users, Home, Trees } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateRange, formatPrice } from "@/lib/utils";
import { formatDistance } from "@/lib/geo";
import { parseJsonArray } from "@/types";
import { nextOccurrence } from "@/lib/event-occurrence";
import { formatAudienceBadge } from "@/lib/event-audience";
import type { events, venues, promoters } from "@/lib/db/schema";
import { AddToCalendar } from "./AddToCalendar";
import { FavoriteButton } from "@/components/FavoriteButton";
import { getCategoryColors, getCategoryBadgeClass, getCategoryImage } from "@/lib/category-colors";
import { getStateName } from "@/lib/states";
import { formatDateMedium, formatDateShort, formatMonthShort } from "@/lib/datetime";

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
    // Cohort 7 (C2/U2, 2026-06-01) — optional list of per-day
    // occurrence dates joined from event_days. When supplied, the
    // badge shows the next FUTURE occurrence instead of the series
    // start date. Backwards-compatible: existing callers that don't
    // join event_days still work — card falls back to publicStartDate
    // ?? startDate (the pre-Cohort-7 behavior).
    eventDayDates?: string[];
  };
  /** Set to true for above-the-fold images to enable priority loading */
  priority?: boolean;
  /** Distance in miles from vendor home base (if available) */
  distance?: number;
}

export function EventCard({ event, priority = false, distance }: EventCardProps) {
  const [imgError, setImgError] = useState(false);
  const categories = parseJsonArray(event.categories);
  const vendors = event.vendors || [];
  const colors = getCategoryColors(categories);

  // Vendor application deadline chip — depends on "now", so defer to client
  // after hydration to avoid SSR/CSR mismatch when page render straddles a
  // day boundary or the deadline is very near.
  const [deadlineChipText, setDeadlineChipText] = useState<string | null>(null);
  useEffect(() => {
    if (!event.applicationDeadline) return;
    const deadlineMs = new Date(event.applicationDeadline).getTime();
    const diffDays = Math.ceil((deadlineMs - Date.now()) / (24 * 60 * 60 * 1000));
    if (diffDays < 0 || diffDays > 14) return;
    if (diffDays === 0) {
      setDeadlineChipText("Applies today");
    } else if (diffDays === 1) {
      setDeadlineChipText("Applies in 1 day");
    } else {
      const short = formatDateShort(event.applicationDeadline);
      setDeadlineChipText(`Applies by ${short}`);
    }
  }, [event.applicationDeadline]);

  // Use public dates for display (falls back to full dates if not set)
  const displayStartDate = event.publicStartDate ?? event.startDate;
  const displayEndDate = event.publicEndDate ?? event.endDate;

  // Cohort 7 (C2/U2) — date badge shows the NEXT occurrence, not the
  // series start. For events whose caller joined event_days into the
  // payload (eventDayDates), this is the next future event_day date.
  // For events without that join (most callers today), the helper
  // falls back to the contiguous-range path — same date the badge
  // showed pre-Cohort-7, so this change is backwards-compatible.
  const occurrence = nextOccurrence(
    {
      startDate: displayStartDate,
      endDate: displayEndDate,
      discontinuousDates: event.discontinuousDates,
      eventDayDates: event.eventDayDates,
    },
    new Date()
  );
  const badgeDate = occurrence?.date ?? (displayStartDate ? new Date(displayStartDate) : null);
  const monthAbbr = badgeDate ? formatMonthShort(badgeDate).toUpperCase() : null;
  const dayNum = badgeDate ? badgeDate.getUTCDate() : null;

  return (
    <Card className="h-full hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden">
      {/* Top accent bar */}
      <div className="h-1" style={{ backgroundColor: colors.accent }} />
      <Link href={`/events/${event.slug}`} className="block">
        <div
          className={`aspect-video relative ${event.imageUrl && !imgError ? "bg-muted" : colors.bg}`}
        >
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
            <Image
              src={getCategoryImage(categories)}
              alt={`${categories[0] || "Event"} illustration`}
              fill
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              className="object-cover"
            />
          )}
          {/* Date badge */}
          {monthAbbr && dayNum && (!event.imageUrl || imgError) && (
            <div className="absolute bottom-3 left-3 bg-card rounded-lg shadow-sm px-2.5 py-1.5 text-center leading-tight">
              <div className="text-xs font-semibold text-amber-fg tracking-wide">{monthAbbr}</div>
              <div className="text-lg font-bold text-navy -mt-0.5">{dayNum}</div>
            </div>
          )}
          <div className="absolute top-3 left-3 flex gap-1 flex-wrap max-w-[calc(100%-48px)]">
            {event.featured && <Badge variant="warning">Featured</Badge>}
            {event.status === "TENTATIVE" && <Badge variant="info">Tentative</Badge>}
            {/* TAX1 Phase 3 (2026-06-02) — A6 audience badge on cards.
                The flex-wrap + max-w guards against the long
                MEMBERS+OPEN label colliding with the favorite button
                on narrow card widths. */}
            {(() => {
              const audienceBadge = formatAudienceBadge(
                event.primaryAudience,
                event.publicAccess,
                event.accessNotes
              );
              return audienceBadge ? (
                <Badge variant={audienceBadge.variant}>{audienceBadge.label}</Badge>
              ) : null;
            })()}
          </div>
          <FavoriteButton
            type="EVENT"
            id={event.id}
            className="absolute top-3 right-3 z-10"
            size="sm"
          />
        </div>
        <div className="p-4">
          <h3 className="font-semibold text-lg text-foreground line-clamp-2">{event.name}</h3>
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Calendar className="w-4 h-4 mr-2 flex-shrink-0" />
                <span>{formatDateRange(displayStartDate, displayEndDate)}</span>
              </div>
              <AddToCalendar
                title={event.name}
                description={event.description || undefined}
                location={
                  event.venue
                    ? `${event.venue.name}, ${event.venue.address}, ${event.venue.city}, ${event.venue.state} ${event.venue.zip}`
                    : undefined
                }
                startDate={event.startDate}
                endDate={event.endDate}
                url={`https://meetmeatthefair.com/events/${event.slug}`}
                variant="icon"
                venueTimezone={event.venue?.timezone}
              />
            </div>
            {event.isStatewide ? (
              <div className="flex items-center min-w-0">
                <MapPin className="w-4 h-4 mr-2 flex-shrink-0" />
                <span className="truncate">
                  Statewide
                  {getStateName(event.stateCode) ? ` — ${getStateName(event.stateCode)}` : ""}
                </span>
              </div>
            ) : (
              event.venue && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center min-w-0">
                    <MapPin className="w-4 h-4 mr-2 flex-shrink-0" />
                    <span className="truncate">
                      {event.venue.name}, {event.venue.city}, {event.venue.state}
                    </span>
                  </div>
                  {distance != null && (
                    <span className="ml-2 flex-shrink-0 text-xs font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                      {formatDistance(distance)}
                    </span>
                  )}
                </div>
              )
            )}
            {event.ticketPriceMinCents !== null && (
              <div className="flex items-center">
                <Tag className="w-4 h-4 mr-2 flex-shrink-0" />
                <span>{formatPrice(event.ticketPriceMinCents, event.ticketPriceMaxCents)}</span>
              </div>
            )}
          </div>
          {/* Scale & Indoor/Outdoor indicators */}
          {(event.eventScale || event.indoorOutdoor) && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              {event.eventScale && (
                <span
                  className="flex items-center gap-0.5"
                  title={
                    event.eventScale === "SMALL"
                      ? "Small community event"
                      : event.eventScale === "MEDIUM"
                        ? "Regional event"
                        : event.eventScale === "LARGE"
                          ? "Large state-level event"
                          : "Major multi-state event"
                  }
                >
                  <Users className="w-3 h-3" />
                  {event.eventScale === "SMALL"
                    ? "Small"
                    : event.eventScale === "MEDIUM"
                      ? "Medium"
                      : event.eventScale === "LARGE"
                        ? "Large"
                        : "Major"}
                </span>
              )}
              {event.indoorOutdoor && (
                <span className="flex items-center gap-0.5">
                  {event.indoorOutdoor === "INDOOR" ? (
                    <>
                      <Home className="w-3 h-3" /> Indoor
                    </>
                  ) : event.indoorOutdoor === "OUTDOOR" ? (
                    <>
                      <Trees className="w-3 h-3" /> Outdoor
                    </>
                  ) : (
                    <>
                      <Home className="w-3 h-3" /> Mixed
                    </>
                  )}
                </span>
              )}
              {event.estimatedAttendance && (
                <span title="Estimated attendance">
                  ~{event.estimatedAttendance.toLocaleString()}
                </span>
              )}
            </div>
          )}
          {(categories.length > 0 || deadlineChipText) && (
            <div className="mt-3 flex flex-wrap gap-1">
              {deadlineChipText && (
                <Badge
                  className="bg-amber-light text-amber-bg-fg"
                  title={`Vendor applications close ${formatDateMedium(event.applicationDeadline!)}`}
                >
                  {deadlineChipText}
                </Badge>
              )}
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
        <div className="px-4 pb-4 pt-2 border-t border-border">
          <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
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
                <div className="aspect-square rounded bg-muted flex items-center justify-center overflow-hidden group-hover:ring-2 ring-royal transition-all relative">
                  {vendor.logoUrl ? (
                    <Image
                      src={vendor.logoUrl}
                      alt={`${vendor.businessName} logo`}
                      fill
                      sizes="48px"
                      className="object-cover"
                    />
                  ) : (
                    <Store className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
              </Link>
            ))}
            {vendors.length > 8 && (
              <Link
                href={`/events/${event.slug}`}
                className="aspect-square rounded bg-muted flex items-center justify-center text-xs text-muted-foreground hover:bg-muted/80 transition-colors"
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

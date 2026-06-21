"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { cdnImage, focalPointGravity } from "@/lib/cdn-image";
import { Calendar, MapPin, Tag, Store, Users, Home, Trees } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDateRange, formatPrice } from "@/lib/utils";
import { formatDistance } from "@/lib/geo";
import { parseJsonArray } from "@/types";
import { nextOccurrence, showsNextOccurrence } from "@/lib/event-occurrence";
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
  /** EH2.1 brand display override; falls back to businessName when null. */
  displayName?: string | null;
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
  /**
   * Set to true for the SINGLE LCP candidate per page. Emits
   * `<link rel="preload" as="image">` + `fetchpriority="high"`. Per
   * web.dev LCP guidance: at most one per page, otherwise browser
   * deprioritizes competing preloads and all of them arrive later.
   *
   * Non-priority cards use Next/Image's default lazy loading; the
   * earlier IMG-followup attempted an `eagerLoad` opt-in here, but
   * Next.js 15.x emits a preload link for `loading="eager"` too, so
   * the opt-in produced the multi-preload problem it was meant to
   * prevent (verified against prod 2026-06-08). Lazy with
   * IntersectionObserver is sufficient for above-the-fold non-LCP.
   */
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

  // U-next (2026-06-21): for a recurring SERIES that's already underway (a
  // weekly/seasonal market), show "Next: <date>" instead of the full season
  // range, which reads as a stale months-long span. Matches the detail page's
  // "Next: …" line and the date badge. See showsNextOccurrence for the rule.
  const showNextOccurrence = showsNextOccurrence(occurrence);

  // Date line label. Priority: recurring series → "Today"/"Next: <date>"; an
  // event whose resolved occurrence is TODAY or that's currently running →
  // "Today" when it ends today (incl. a single-day event today) else "Now
  // through <end>" (never a backward range that reads as a stale past event);
  // otherwise the normal start–end range. (isToday is checked alongside
  // isOngoing because a single event_day today comes back via Path 1 with
  // isOngoing=false but isToday=true.)
  const sameUTCDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
  const endsToday = displayEndDate ? sameUTCDay(new Date(displayEndDate), new Date()) : false;
  const dateLabel = showNextOccurrence
    ? occurrence!.isToday
      ? "Today"
      : `Next: ${formatDate(occurrence!.date)}`
    : occurrence?.isToday || occurrence?.isOngoing
      ? endsToday || !displayEndDate
        ? "Today"
        : `Now through ${formatDate(displayEndDate)}`
      : formatDateRange(displayStartDate, displayEndDate);

  return (
    <Card className="h-full hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden">
      {/* Top accent bar */}
      <div className="h-1" style={{ backgroundColor: colors.accent }} />
      <Link href={`/events/${event.slug}`} className="block">
        <div
          className={`aspect-video relative ${event.imageUrl && !imgError ? "bg-muted" : colors.bg}`}
        >
          {event.imageUrl && !imgError ? (
            // Per the `cloudflare-image-optimization` skill (installed
            // 2026-06-08): card thumbnails use server-side `fit=cover`
            // (rule #7) on a width ladder capped at 1200 (rule #6 says
            // cap ~1600-2048; the card pattern in the skill caps tighter
            // because cards are smaller). Replaces the pre-skill path
            // through next/image's custom loader, which only emitted
            // width-only resizes (no `fit`/`gravity`) and let CSS
            // `object-cover` do client-side center-crop on a 1942-wide
            // source — wasted bytes on mobile + same crop result.
            //
            // No `gravity` arg — center-crop matches the skill's card
            // example and avoids the saliency-drift bug that bit PR #392
            // (see [[feedback_smart_crop_wrong_for_posters]]). Poster
            // thumbnails get cropped at the edges; users click through
            // to see the full image on the detail page (which uses the
            // blurred-fill pattern from PR #393).
            //
            // Width ladder: 400 / 600 / 800 / 1200. Covers 100vw mobile
            // (≤768px), 50vw tablet (≤1200px), 33vw desktop (≥1200px)
            // at both 1x and 2x DPR without exceeding 1200w.
            //
            // LCP: only the i===0 card on a page sets `priority` →
            // `loading="eager"` + `fetchpriority="high"` (rule #3).
            // Other cards lazy-load. Raw <img> here so the manual
            // srcSet + per-width crop params can be expressed (the
            // next/image loader signature can't pass `fit`/`gravity`).
            (() => {
              // IMG1 §1b Phase 1 (2026-06-08) — per-image focal point.
              // Pulled from events.image_focal_x/y (defaults 0.5/0.5 =
              // center, identical URL to pre-focal-point cards). When an
              // operator sets a non-default focal point in the admin UI,
              // it flows through here to Cloudflare as `gravity=XxY` and
              // the crop window slides accordingly — same data model as
              // Eventbrite's fp-x/fp-y.
              const gravity = focalPointGravity(event.imageFocalX, event.imageFocalY);
              const cardWidths = [400, 600, 800, 1200];
              const cardSrcSet = cardWidths
                .map((w) =>
                  cdnImage(event.imageUrl!, {
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
              const cardSrc = cdnImage(event.imageUrl, {
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
                  alt={`Photo of ${event.name} event`}
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
            // Category placeholder SVG — vector, no CDN transform needed.
            // Same width/height + lazy/eager semantics as the photo path
            // so layout doesn't shift when imgError flips.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={getCategoryImage(categories)}
              alt={`${categories[0] || "Event"} illustration`}
              width={800}
              height={450}
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover"
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
                <span>{dateLabel}</span>
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
                eventSlug={event.slug}
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
                    <span className="ml-2 flex-shrink-0 text-xs font-medium text-info-soft-foreground bg-info-soft px-1.5 py-0.5 rounded">
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
            {vendors.slice(0, 8).map((vendor) => {
              // EH2.1 — honor brand display_name override on the small
              // vendor logo tiles. Tooltip + alt text use the override
              // when present.
              const vendorDisplay = vendor.displayName ?? vendor.businessName;
              return (
                <Link
                  key={vendor.id}
                  href={`/vendors/${vendor.slug}`}
                  className="block group"
                  title={vendorDisplay}
                >
                  <div className="aspect-square rounded bg-muted flex items-center justify-center overflow-hidden group-hover:ring-2 ring-royal transition-all relative">
                    {vendor.logoUrl ? (
                      <Image
                        src={vendor.logoUrl}
                        alt={`${vendorDisplay} logo`}
                        fill
                        sizes="48px"
                        className="object-cover"
                      />
                    ) : (
                      <Store className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                </Link>
              );
            })}
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

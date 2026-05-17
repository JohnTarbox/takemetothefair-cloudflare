import { parseDateLoose, parseWallClockInVenueZone, formatIsoInVenueZone } from "@/lib/datetime";
import { LIFECYCLE_TO_SCHEMA_ORG, type EventLifecycle } from "@/lib/event-lifecycle";

interface EventDay {
  date: string;
  openTime: string;
  closeTime: string;
  notes?: string | null;
  closed?: boolean | null;
  // Allow additional DB fields
  id?: string;
  eventId?: string;
  createdAt?: Date | null;
}

interface EventVendor {
  name: string;
  url: string;
  /** Optional — drives schema.org performer-vs-sponsor placement (drizzle/0071,
   *  2026-05-16). Omit for legacy callers; treated as EXHIBITOR. */
  participationType?: "EXHIBITOR" | "SPONSOR_ONLY" | "SPONSOR_AND_EXHIBITOR" | null;
}

interface EventSchemaProps {
  name: string;
  slug: string;
  description?: string;
  startDate?: Date | null;
  endDate?: Date | null;
  imageUrl?: string | null;
  url: string;
  venue?: {
    name: string;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
  stateCode?: string | null;
  organizer?: {
    name: string;
    url?: string | null;
  } | null;
  // Integer cents per the project's money convention (post-PR-#56).
  // Component converts to dollars locally before emitting to JSON-LD.
  ticketPriceMinCents?: number | null;
  ticketPriceMaxCents?: number | null;
  ticketUrl?: string | null;
  categories?: string[];
  datesConfirmed?: boolean | null;
  // Lifecycle drives the schema.org eventStatus URI (post-PR-#157). Optional
  // on the prop so callers that haven't been updated yet keep working — the
  // mapping falls back to the legacy `datesConfirmed`-based heuristic below.
  lifecycleStatus?: EventLifecycle | string | null;
  // For RESCHEDULED events, the dates the event was previously scheduled for.
  // Required by schema.org's EventRescheduled rich snippet to render in Google.
  previousStartDate?: Date | null;
  previousEndDate?: Date | null;
  eventDays?: EventDay[];
  vendors?: EventVendor[];
  createdAt?: Date | null;
}

function getEventType(categories?: string[]): string {
  if (!categories?.length) return "Event";
  const cats = categories.map((c) => c.toLowerCase());
  if (cats.some((c) => c.includes("fair") || c.includes("festival"))) return "Festival";
  if (cats.some((c) => c.includes("sale") || c.includes("market") || c.includes("flea")))
    return "SaleEvent";
  if (cats.some((c) => c.includes("food") || c.includes("tasting"))) return "FoodEvent";
  if (cats.some((c) => c.includes("craft") || c.includes("exhibit"))) return "ExhibitionEvent";
  return "Event";
}

export function EventSchema({
  name,
  slug,
  description,
  startDate,
  endDate,
  imageUrl,
  url,
  venue,
  stateCode,
  organizer,
  ticketPriceMinCents,
  ticketPriceMaxCents,
  ticketUrl,
  categories,
  datesConfirmed,
  lifecycleStatus,
  previousStartDate,
  previousEndDate,
  eventDays,
  vendors,
  createdAt,
}: EventSchemaProps) {
  // Convert integer cents → dollars for JSON-LD emission. Round-2 backlog
  // item 1 (2026-05-11): only emit `offers` and `isAccessibleForFree` when
  // price is *known*. The previous code treated null/undefined as free,
  // which surfaced "Free admission" on Google's event-rich-result carousel
  // for paid events like the $14-gate Fryeburg Fair.
  const hasKnownPrice =
    (ticketPriceMinCents !== null && ticketPriceMinCents !== undefined) ||
    (ticketPriceMaxCents !== null && ticketPriceMaxCents !== undefined);
  const priceMinDollars =
    ticketPriceMinCents !== null && ticketPriceMinCents !== undefined
      ? ticketPriceMinCents / 100
      : null;
  const priceMaxDollars =
    ticketPriceMaxCents !== null && ticketPriceMaxCents !== undefined
      ? ticketPriceMaxCents / 100
      : null;
  // Confirmed-free only when min is explicitly 0; omitted when unknown.
  const isAccessibleForFree = priceMinDollars === 0 ? true : undefined;

  const location = venue
    ? {
        "@type": "Place",
        name: venue.name,
        address: {
          "@type": "PostalAddress",
          streetAddress: venue.address || undefined,
          addressLocality: venue.city || undefined,
          addressRegion: venue.state || undefined,
          postalCode: venue.zip || undefined,
          addressCountry: "US",
        },
        geo:
          venue.latitude && venue.longitude
            ? {
                "@type": "GeoCoordinates",
                latitude: venue.latitude,
                longitude: venue.longitude,
              }
            : undefined,
      }
    : {
        "@type": "Place",
        name: "Location to be announced",
        address: {
          "@type": "PostalAddress",
          addressRegion: stateCode || undefined,
          addressCountry: "US",
        },
      };

  const hasDates = startDate && endDate;
  const validFromDate = createdAt ? new Date(createdAt).toISOString() : undefined;
  const resolvedImage = imageUrl || `https://meetmeatthefair.com/api/og?slug=${slug}`;

  // Schema.org eventStatus: prefer the lifecycle column (post-PR-#157), fall
  // back to the legacy datesConfirmed heuristic for any caller / fixture not
  // yet passing lifecycleStatus. LIFECYCLE_TO_SCHEMA_ORG.OCCURRED is null —
  // we omit eventStatus for past events since schema.org's vocabulary has no
  // OCCURRED equivalent and emitting EventScheduled for a past event sends
  // a misleading signal to crawlers.
  const lifecycleSchemaStatus = lifecycleStatus
    ? (LIFECYCLE_TO_SCHEMA_ORG[lifecycleStatus as EventLifecycle] ?? null)
    : null;
  const eventStatus =
    lifecycleSchemaStatus ??
    (!hasDates || datesConfirmed === false
      ? "https://schema.org/EventPostponed"
      : "https://schema.org/EventScheduled");

  // MOVED_ONLINE flips the attendance mode; otherwise the default Offline.
  const eventAttendanceMode =
    lifecycleStatus === "MOVED_ONLINE"
      ? "https://schema.org/OnlineEventAttendanceMode"
      : "https://schema.org/OfflineEventAttendanceMode";

  // EventRescheduled rich snippet requires previousStartDate to render. Emit
  // both endpoints when present so Google can show the "rescheduled from X
  // to Y" annotation in search results.
  const previousStartIso =
    lifecycleStatus === "RESCHEDULED" && previousStartDate
      ? (parseDateLoose(previousStartDate)?.toISOString() ?? undefined)
      : undefined;
  const previousEndIso =
    lifecycleStatus === "RESCHEDULED" && previousEndDate
      ? (parseDateLoose(previousEndDate)?.toISOString() ?? undefined)
      : undefined;

  // Only emit `offers` when price is known. Schema.org marks `offers` as
  // recommended-but-not-required, so omitting is the honest signal when we
  // don't know whether an event is free or paid. `JSON.parse(JSON.stringify())`
  // below strips the `undefined` from the final output.
  const offers = !hasKnownPrice
    ? undefined
    : priceMaxDollars !== null && priceMinDollars !== null && priceMaxDollars !== priceMinDollars
      ? {
          "@type": "AggregateOffer",
          url: ticketUrl || url,
          lowPrice: priceMinDollars,
          highPrice: priceMaxDollars,
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
          validFrom: validFromDate,
        }
      : {
          "@type": "Offer",
          url: ticketUrl || url,
          price: priceMinDollars ?? priceMaxDollars ?? 0,
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
          validFrom: validFromDate,
        };

  const organizerBlock = organizer
    ? {
        "@type": "Organization",
        name: organizer.name,
        url: organizer.url || url,
      }
    : undefined;

  const subEvents =
    eventDays && eventDays.length > 0
      ? eventDays
          .filter((d) => !d.closed)
          .map((day, i) => {
            // Sub-event open/close times are wall-clock in the venue's zone.
            // Emit them as ISO with the proper offset (`-04:00`/`-05:00`)
            // so calendar consumers and search crawlers don't have to guess.
            const startWall = parseWallClockInVenueZone(day.date, day.openTime);
            const endWall = parseWallClockInVenueZone(day.date, day.closeTime);
            return {
              "@type": "Event",
              name: `${name} - Day ${i + 1}`,
              startDate: formatIsoInVenueZone(startWall) || undefined,
              endDate: formatIsoInVenueZone(endWall) || undefined,
              description: day.notes || description || `${name} - Day ${i + 1}`,
              location,
              image: resolvedImage,
              eventStatus,
              offers,
              organizer: organizerBlock,
            };
          })
      : undefined;

  const schema = {
    "@context": "https://schema.org",
    "@type": getEventType(categories),
    name,
    description: description || `${name} - a fair and community event.`,
    ...(hasDates
      ? {
          // Defensive: parseDateLoose returns null on Invalid Date instead of
          // throwing on .toISOString() — protects the SSR render against bad
          // input from upstream.
          startDate: parseDateLoose(startDate)?.toISOString() ?? undefined,
          endDate: parseDateLoose(endDate)?.toISOString() ?? undefined,
        }
      : {}),
    image: resolvedImage,
    url,
    eventStatus,
    previousStartDate: previousStartIso,
    previousEndDate: previousEndIso,
    eventAttendanceMode,
    isAccessibleForFree,
    about:
      categories && categories.length > 0
        ? categories.map((category) => ({
            "@type": "Thing",
            name: category,
          }))
        : undefined,
    location,
    subEvent: subEvents,
    organizer: organizerBlock,
    // Split vendor lineup into schema.org `performer` + `sponsor` per the
    // 2026-05-16 spec. EXHIBITOR / SPONSOR_AND_EXHIBITOR vendors go in
    // performer; SPONSOR_ONLY / SPONSOR_AND_EXHIBITOR vendors go in sponsor.
    // SPONSOR_AND_EXHIBITOR appears in BOTH arrays (honest signal that the
    // org is funding the event AND has a booth on the floor). Legacy
    // vendors without participationType set default to EXHIBITOR.
    performer: (() => {
      if (!vendors || vendors.length === 0) return undefined;
      const exhibitors = vendors.filter(
        (v) =>
          v.participationType == null ||
          v.participationType === "EXHIBITOR" ||
          v.participationType === "SPONSOR_AND_EXHIBITOR"
      );
      return exhibitors.length > 0
        ? exhibitors.map((v) => ({ "@type": "Organization", name: v.name, url: v.url }))
        : undefined;
    })(),
    sponsor: (() => {
      if (!vendors || vendors.length === 0) return undefined;
      const sponsors = vendors.filter(
        (v) =>
          v.participationType === "SPONSOR_ONLY" || v.participationType === "SPONSOR_AND_EXHIBITOR"
      );
      return sponsors.length > 0
        ? sponsors.map((v) => ({ "@type": "Organization", name: v.name, url: v.url }))
        : undefined;
    })(),
    offers,
  };

  // Remove undefined values for cleaner output
  const cleanSchema = JSON.parse(JSON.stringify(schema));

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(cleanSchema) }}
    />
  );
}

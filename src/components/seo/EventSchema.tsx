import { parseDateLoose, parseWallClockInVenueZone, formatIsoInVenueZone } from "@/lib/datetime";
import { LIFECYCLE_TO_SCHEMA_ORG, type EventLifecycle } from "@/lib/event-lifecycle";
import { displayVenueName } from "@/lib/venue-display";
import { formatAudienceBadge, isClosedToPublic, hasNonDefaultAudience } from "@/lib/event-audience";
import type { PrimaryAudience, PublicAccess } from "@takemetothefair/constants";

interface EventDay {
  date: string;
  // DQ4 (drizzle/0118, 2026-06-08): openTime/closeTime are nullable.
  // The subEvent emission below skips rows where either is null —
  // Schema.org Event without startDate is malformed.
  openTime: string | null;
  closeTime: string | null;
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
  /** K18 Phase 2 (drizzle/0114, 2026-06-06) — per-occurrence scoping.
   *  - null/undefined: series-wide vendor; appears in the top-level
   *    performer/sponsor arrays (preserves pre-K18 emission).
   *  - non-null: scoped to that event_day_id; appears under the matching
   *    subEvent's performer/sponsor arrays and is OMITTED from the
   *    top-level arrays so the emitted graph doesn't double-count. */
  eventDayId?: string | null;
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
    /** Venue's IANA timezone (P3b, drizzle/0112). Threaded into the
     *  sub-event startDate/endDate ISO offsets so the JSON-LD `-04:00`
     *  / `-05:00` (Eastern) is replaced by the venue's actual offset for
     *  non-Eastern locations. Optional for backward compat — falls back
     *  to VENUE_TZ when omitted. */
    timezone?: string | null;
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
  // TAX1 Phase 3 (2026-06-02) — audience/access taxonomy. Both
  // optional so legacy callers continue to render without these
  // fields. The lib/event-audience.ts helpers null-coalesce missing
  // values to the permissive default (PUBLIC + OPEN), which means
  // the schema is unchanged for any caller that hasn't been updated
  // yet (and for the ~95% of events that ARE PUBLIC + OPEN).
  primaryAudience?: PrimaryAudience | null;
  publicAccess?: PublicAccess | null;
  accessNotes?: string | null;
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
  // `slug` kept in the prop type for caller compatibility but no longer
  // consumed inside the component (the dynamic /api/og?slug=… image URL
  // was retired 2026-06-04 in favour of the static og-default.png).
  slug: _slug,
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
  primaryAudience,
  publicAccess,
  accessNotes,
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
        // Cohort 8 follow-up (2026-06-01) — use the same display fallback
        // as the venue detail page H1, so a street-address-named venue
        // surfaces as "Event venue in {City}, {State}" in event JSON-LD
        // rather than "18 Spring Street". Google Rich Results prefers a
        // descriptive name over a street address.
        name: displayVenueName(venue),
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
  // Static OG fallback — `/api/og` dynamic generator removed 2026-06-04
  // to keep the main-app Worker under the 25 MiB Cloudflare bundle cap
  // (the satori + resvg-wasm chain was ~476 KiB compiled). 81% of events
  // don't have a per-event image, so the previous /api/og?slug=… path
  // was the common case; the static og-default.png is already used by
  // every other listing/index page in the site.
  const resolvedImage = imageUrl || "https://meetmeatthefair.com/og-default.png";

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

  // TAX1 Phase 3 (2026-06-02) — A7 SEO accuracy lever. When the event
  // is CLOSED to the public (members-only, credential-gated B2B,
  // etc.), suppress the entire `offers` block. Emitting `offers` on a
  // CLOSED event tells Google's rich-result crawler "this is bookable
  // by anyone for $X" — the exact harm this feature exists to prevent
  // (the Maine Association of Retirees Annual Meeting surfacing as a
  // public attraction). The price gate above still applies for OPEN
  // events.
  const closedToPublic = isClosedToPublic(publicAccess);

  // Only emit `offers` when price is known AND the event is open. Schema.org
  // marks `offers` as recommended-but-not-required, so omitting is the honest
  // signal when we don't know whether an event is free or paid OR when the
  // event isn't bookable by the public.
  // `JSON.parse(JSON.stringify())` below strips the `undefined` from the
  // final output.
  const offers =
    !hasKnownPrice || closedToPublic
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

  // K18 Phase 2 (2026-06-06): bucket the vendor lineup once so subEvent
  // emission and the top-level performer/sponsor arrays can share the
  // partition without re-walking the list. Series-wide vendors keep
  // appearing at the top level (per pre-K18 contract); per-day vendors
  // get attached to the matching subEvent and OMITTED from the top level
  // to avoid double-counting in the emitted JSON-LD graph.
  const vendorsByDay = new Map<string, EventVendor[]>();
  const seriesWideVendors: EventVendor[] = [];
  if (vendors && vendors.length > 0) {
    for (const v of vendors) {
      if (v.eventDayId == null) {
        seriesWideVendors.push(v);
      } else {
        const arr = vendorsByDay.get(v.eventDayId) ?? [];
        arr.push(v);
        vendorsByDay.set(v.eventDayId, arr);
      }
    }
  }

  // Helper: produce schema.org performer/sponsor arrays for a given vendor
  // bucket using the same EXHIBITOR-vs-SPONSOR rule the top-level emitter
  // uses. Returns `undefined` (so the property is dropped) when empty.
  function vendorBucketToPerformerSponsor(bucket: EventVendor[]) {
    if (bucket.length === 0) return { performer: undefined, sponsor: undefined };
    const exhibitors = bucket.filter(
      (v) =>
        v.participationType == null ||
        v.participationType === "EXHIBITOR" ||
        v.participationType === "SPONSOR_AND_EXHIBITOR"
    );
    const sponsorsList = bucket.filter(
      (v) =>
        v.participationType === "SPONSOR_ONLY" || v.participationType === "SPONSOR_AND_EXHIBITOR"
    );
    return {
      performer:
        exhibitors.length > 0
          ? exhibitors.map((v) => ({ "@type": "Organization", name: v.name, url: v.url }))
          : undefined,
      sponsor:
        sponsorsList.length > 0
          ? sponsorsList.map((v) => ({ "@type": "Organization", name: v.name, url: v.url }))
          : undefined,
    };
  }

  const subEvents =
    eventDays && eventDays.length > 0
      ? eventDays
          .filter((d) => !d.closed)
          // DQ4 (2026-06-08): drop days where hours weren't captured.
          // Schema.org Event requires startDate; emitting subEvents with
          // null startDate would fail Rich Results validation. The render
          // surface still shows "Hours not yet confirmed" for these days.
          // Type predicate narrows day.openTime/closeTime to string for
          // the subsequent .map().
          .filter(
            (d): d is EventDay & { openTime: string; closeTime: string } =>
              d.openTime != null && d.closeTime != null
          )
          .map((day, i) => {
            // Sub-event open/close times are wall-clock in the venue's zone.
            // Emit them as ISO with the proper offset (`-04:00`/`-05:00` at
            // Eastern, `-02:30`/`-03:30` at Newfoundland, etc.) so calendar
            // consumers and search crawlers don't have to guess. P3b threads
            // `venue.timezone` through; absent venue uses VENUE_TZ default.
            const venueTz = venue?.timezone ?? undefined;
            const startWall = parseWallClockInVenueZone(day.date, day.openTime, venueTz);
            const endWall = parseWallClockInVenueZone(day.date, day.closeTime, venueTz);
            // K18 Phase 2: per-day performer/sponsor — only the vendors
            // scoped specifically to this event_day. Absent or empty -> the
            // properties are dropped from emission (no empty arrays).
            const dayBucket = day.id ? (vendorsByDay.get(day.id) ?? []) : [];
            const { performer: dayPerformer, sponsor: daySponsor } =
              vendorBucketToPerformerSponsor(dayBucket);
            return {
              "@type": "Event",
              name: `${name} - Day ${i + 1}`,
              startDate: venueTz
                ? formatIsoInVenueZone(startWall, venueTz) || undefined
                : formatIsoInVenueZone(startWall) || undefined,
              endDate: venueTz
                ? formatIsoInVenueZone(endWall, venueTz) || undefined
                : formatIsoInVenueZone(endWall) || undefined,
              description: day.notes || description || `${name} - Day ${i + 1}`,
              location,
              image: resolvedImage,
              eventStatus,
              offers,
              organizer: organizerBlock,
              performer: dayPerformer,
              sponsor: daySponsor,
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
    // TAX1 Phase 3 (2026-06-02) — A7. Emit schema.org `audience`
    // when the event has a non-default audience/access pair. The
    // human-readable label from formatAudienceBadge() doubles as the
    // audienceType — schema.org's spec accepts free text. Crawlers
    // pair this with the offers-suppression above to understand
    // "this isn't bookable by the general public" — the core SEO
    // accuracy fix for restricted events.
    audience: hasNonDefaultAudience(primaryAudience, publicAccess)
      ? {
          "@type": "Audience",
          audienceType:
            formatAudienceBadge(primaryAudience, publicAccess, accessNotes)?.label ?? "Restricted",
        }
      : undefined,
    subEvent: subEvents,
    organizer: organizerBlock,
    // Split vendor lineup into schema.org `performer` + `sponsor` per the
    // 2026-05-16 spec. EXHIBITOR / SPONSOR_AND_EXHIBITOR vendors go in
    // performer; SPONSOR_ONLY / SPONSOR_AND_EXHIBITOR vendors go in sponsor.
    // SPONSOR_AND_EXHIBITOR appears in BOTH arrays (honest signal that the
    // org is funding the event AND has a booth on the floor). Legacy
    // vendors without participationType set default to EXHIBITOR.
    //
    // K18 Phase 2 (2026-06-06): the top-level arrays carry SERIES-WIDE
    // vendors only (vendorsByDay rows are emitted under their subEvent
    // entry above). Pre-K18 lineups have everything in seriesWideVendors,
    // so the emission is unchanged for events that haven't adopted
    // per-day scoping.
    ...vendorBucketToPerformerSponsor(seriesWideVendors),
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

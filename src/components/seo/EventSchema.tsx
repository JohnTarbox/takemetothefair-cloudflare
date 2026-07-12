import { parseDateLoose, parseWallClockInVenueZone, formatIsoInVenueZone } from "@/lib/datetime";
import { LIFECYCLE_TO_SCHEMA_ORG, type EventLifecycle } from "@/lib/event-lifecycle";
import { buildPlaceJsonLd } from "@/lib/seo/place-jsonld";
import { formatAudienceBadge, isClosedToPublic, hasNonDefaultAudience } from "@/lib/event-audience";
import type { PrimaryAudience, PublicAccess } from "@takemetothefair/constants";
import { SITE_URL } from "@takemetothefair/constants";
import {
  buildPerformerNodes,
  performerSchemaType,
  type ConfirmedAppearance,
} from "@/lib/performers/event-jsonld";

interface EventDay {
  date: string;
  // DQ4 (drizzle/0118, 2026-06-08): openTime/closeTime are nullable.
  // The subEvent emission below skips rows where either is null —
  // Schema.org Event without startDate is malformed.
  openTime: string | null;
  closeTime: string | null;
  notes?: string | null;
  closed?: boolean | null;
  // F2 / E.2b (Dev-Email-2026-06-09 §E.2, 2026-06-09) — per-occurrence
  // image. PR #412 added the column; subEvent.image below prefers
  // this per-day URL when present and falls back to the series-level
  // `resolvedImage` otherwise. Schema.org allows multi-occurrence
  // events to advertise per-day art; search results for a specific
  // date can show the matching image.
  imageUrl?: string | null;
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
  /**
   * EH3 P2.3b — when this event is an occurrence of a series, the embedded
   * `superEvent` EventSeries reference (built by buildSuperEventRef). Null/omitted
   * for standalone events, which is every event until the P1 backfill links them.
   */
  superEvent?: Record<string, unknown> | null;
  // OPE-114 — CONFIRMED performer appearances for this event. Emitted as the
  // schema.org `performer` who-list (deduped, billing-ordered) MERGED with the
  // existing vendor-exhibitor performers (acts first). Only CONFIRMED acts are
  // passed here (the loader filters); PENDING/CANCELLED never reach the schema.
  performers?: ConfirmedAppearance[];
  // OPE-114 §6.1a — when true, ALSO emit one `subEvent` per confirmed timed
  // appearance (Mr. Drew, Sat 3 PM). Global feature flag, DEFAULT OFF: times are
  // shown on-page but not submitted to search engines until John flips it.
  emitPerformerSubevents?: boolean;
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
  performers,
  emitPerformerSubevents,
  createdAt,
  primaryAudience,
  publicAccess,
  accessNotes,
  superEvent,
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

  // K46 (2026-06-26) — Place node now comes from the shared buildPlaceJsonLd
  // helper so the event + series builders emit byte-identical `location`. The
  // Cohort 8 displayVenueName fallback ("Event venue in {City}, {State}" for a
  // street-address-named venue) and the lat/long GeoCoordinates gate live in
  // the helper. When `venue` is absent we still emit a Place (state code only),
  // which keeps the required-field check satisfied.
  const location = buildPlaceJsonLd(venue, stateCode);

  const hasDates = startDate && endDate;

  // startDate fallback (2026-06-26): an event whose dates live ONLY in
  // event_days — a null top-level start/end, common for single-day events built
  // via the day grid — must STILL emit a top-level startDate, or Google Rich
  // Results flags "Missing field startDate". The required field is on the parent
  // Event; the dated subEvents below do NOT satisfy it. Mirrors the K46 location
  // fix: always satisfy the required field. Derive the span from the day rows —
  // earliest open → latest close as a precise wall-clock datetime (matching the
  // subEvents); if no day captured hours, fall back to the bare calendar-date
  // span (schema.org startDate accepts a Date as well as a DateTime).
  const dayDerivedDates: { start: string; end: string } | undefined = (() => {
    if (hasDates || !eventDays || eventDays.length === 0) return undefined;
    const venueTz = venue?.timezone ?? undefined;
    const withHours = eventDays.filter(
      (d): d is EventDay & { openTime: string; closeTime: string } =>
        !d.closed && d.openTime != null && d.closeTime != null
    );
    const starts = withHours
      .map((d) => parseWallClockInVenueZone(d.date, d.openTime, venueTz))
      .filter((x): x is Date => x != null);
    const ends = withHours
      .map((d) => parseWallClockInVenueZone(d.date, d.closeTime, venueTz))
      .filter((x): x is Date => x != null);
    if (starts.length > 0 && ends.length > 0) {
      const minStart = starts.reduce((a, b) => (a < b ? a : b));
      const maxEnd = ends.reduce((a, b) => (a > b ? a : b));
      const start = venueTz
        ? formatIsoInVenueZone(minStart, venueTz)
        : formatIsoInVenueZone(minStart);
      const end = venueTz ? formatIsoInVenueZone(maxEnd, venueTz) : formatIsoInVenueZone(maxEnd);
      if (start && end) return { start, end };
    }
    // No captured hours — a bare calendar-date span still satisfies the field.
    const sorted = eventDays
      .map((d) => d.date)
      .filter(Boolean)
      .sort();
    return sorted.length ? { start: sorted[0], end: sorted[sorted.length - 1] } : undefined;
  })();
  // Feeds both the eventStatus heuristic and the JSON-LD date emission, so a
  // day-derived event reads as Scheduled (not Postponed) AND carries dates.
  const hasEffectiveDates = !!hasDates || !!dayDerivedDates;

  // OPE-32 — resolve the effective start/end: top-level column, else the
  // event_days-derived span (the K48 fallback above). A Schema.org Event without
  // startDate is invalid, so when NO date is derivable (top-level null AND no
  // event_days — the 11 genuinely-dateless TENTATIVE events), SUPPRESS the whole
  // Event node instead of emitting a dateless one that GSC flags "Missing field
  // startDate". The human-readable page is unaffected — this is JSON-LD only.
  const resolvedStartDate =
    (startDate ? (parseDateLoose(startDate)?.toISOString() ?? undefined) : undefined) ??
    dayDerivedDates?.start;
  const resolvedEndDate =
    (endDate ? (parseDateLoose(endDate)?.toISOString() ?? undefined) : undefined) ??
    dayDerivedDates?.end;
  if (!resolvedStartDate) return null;

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
  // yet passing lifecycleStatus.
  //
  // OPE-183 (2026-07-12) — DECISION, keep the two builders aligned: a past /
  // OCCURRED event maps to null (LIFECYCLE_TO_SCHEMA_ORG.OCCURRED === null,
  // schema.org has no OCCURRED value) and THEN takes the dated-fallback below to
  // `EventScheduled` — it is NOT omitted. That is intentional and spec-correct:
  // schema.org's EventScheduled is defined as "The event is taking place OR HAS
  // TAKEN PLACE on the startDate as scheduled" and is the value assumed by
  // default when eventStatus is absent — so emitting it on a past event is
  // accurate, and suppressing it would change nothing semantically. The series
  // builder (series-schema-org.ts `eventStatusForDatedNode`) mirrors this exactly.
  // If you ever change one, change both and update docs/SCHEMA_ORG.md. (An
  // earlier version of this comment wrongly claimed past events were omitted.)
  const lifecycleSchemaStatus = lifecycleStatus
    ? (LIFECYCLE_TO_SCHEMA_ORG[lifecycleStatus as EventLifecycle] ?? null)
    : null;
  const eventStatus =
    lifecycleSchemaStatus ??
    (!hasEffectiveDates || datesConfirmed === false
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

  // OPE-111 — emit `offers` whenever the event carries a purchase/attendance
  // signal, not only when a price is known. An event with a `ticketUrl` clearly
  // HAS an offer (you can buy tickets there) even if we don't store the price;
  // gating solely on `hasKnownPrice` left ~100 ticketed events with no `offers`
  // block, a GSC "Improve item appearance" recommended-field gap.
  //   - price known  → emit the Offer/AggregateOffer with the price (unchanged).
  //   - ticketUrl only (price unknown) → emit a price-LESS Offer (url +
  //     availability + validFrom). Honest: there's a way to get in, we just don't
  //     claim a price.
  //   - no price AND no ticketUrl → cleanly OMIT. We deliberately do NOT fabricate
  //     `price: 0`/free here: we can't tell "free" from "price unknown", and doing
  //     so reintroduces the documented false-"Free admission" regression on
  //     paid-gate events like the $14 Fryeburg Fair (see the hasKnownPrice note
  //     above). This also honours OPE-41's "empty offer is worse than none".
  // CLOSED-to-public events suppress `offers` entirely (TAX1 accuracy lever).
  // `JSON.parse(JSON.stringify())` below strips any `undefined` from the output.
  const hasTicketUrl = typeof ticketUrl === "string" && ticketUrl.length > 0;
  const offers =
    closedToPublic || (!hasKnownPrice && !hasTicketUrl)
      ? undefined
      : !hasKnownPrice
        ? {
            // ticketUrl present, price unknown — honest price-less Offer.
            "@type": "Offer",
            url: ticketUrl || url,
            availability: "https://schema.org/InStock",
            validFrom: validFromDate,
          }
        : priceMaxDollars !== null &&
            priceMinDollars !== null &&
            priceMaxDollars !== priceMinDollars
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

  // OPE-111 — emit organizer.url only when the organizer actually has one
  // (promoter website). Previously this fell back to the EVENT page URL when the
  // promoter had no website, which misrepresented our own event page as the
  // organizer's site; omit cleanly instead (the ~34% of promoters without a
  // website simply carry organizer name only).
  const organizerBlock = organizer
    ? {
        "@type": "Organization",
        name: organizer.name,
        ...(organizer.url ? { url: organizer.url } : {}),
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
              // E.2b — use per-day image when set, else series-level.
              // resolvedImage covers the OG-fallback + transformations
              // chain (see resolveImage above); the per-day URL is
              // emitted as-is on the assumption that operators set it
              // to a usable CDN URL (same convention as the series
              // image_url column).
              image: day.imageUrl || resolvedImage,
              eventStatus,
              offers,
              organizer: organizerBlock,
              performer: dayPerformer,
              sponsor: daySponsor,
            };
          })
      : undefined;

  // OPE-114 — schema.org `performer`. The vendor lineup already maps EXHIBITOR
  // vendors → `performer` (drizzle/0071); MERGE the confirmed acts in FRONT of
  // them (acts are the true performers, billing-ordered), keeping the vendor
  // `sponsor` split intact. Omitted entirely when neither exists.
  const vendorSplit = vendorBucketToPerformerSponsor(seriesWideVendors);
  const actNodes = buildPerformerNodes(performers ?? [], SITE_URL);
  const combinedPerformers = [...(actNodes ?? []), ...(vendorSplit.performer ?? [])];
  const performerArray = combinedPerformers.length > 0 ? combinedPerformers : undefined;

  // §6.1a — one sub-Event per confirmed TIMED appearance (Mr. Drew, Sat 3 PM).
  // Behind the emit_performer_subevents flag (DEFAULT OFF): built but not emitted
  // until John flips it, so appearance times show on-page yet aren't fed to Google.
  const performerSubEvents =
    emitPerformerSubevents && performers && performers.length > 0
      ? performers
          .filter((p) => p.performanceStart != null)
          .map((p) => ({
            "@type": "Event",
            name: `${name}: ${p.name}`,
            startDate: new Date((p.performanceStart as number) * 1000).toISOString(),
            ...(p.performanceEnd != null
              ? { endDate: new Date(p.performanceEnd * 1000).toISOString() }
              : {}),
            location,
            performer: [
              {
                "@type": performerSchemaType(p.performerType, p.actCategory),
                name: p.name,
                url: `${SITE_URL}/performers/${p.slug}`,
                ...(p.sameAs ? { sameAs: p.sameAs } : {}),
              },
            ],
          }))
      : [];
  const allSubEvents =
    performerSubEvents.length > 0 ? [...(subEvents ?? []), ...performerSubEvents] : subEvents;

  const schema = {
    "@context": "https://schema.org",
    "@type": getEventType(categories),
    name,
    // EH3 P2.3b — superEvent → the parent EventSeries (occurrences only).
    ...(superEvent ? { superEvent } : {}),
    description: description || `${name} - a fair and community event.`,
    // OPE-32 — emit the resolved start (guaranteed present; the node is
    // suppressed above when it isn't) and the resolved end when known.
    startDate: resolvedStartDate,
    ...(resolvedEndDate ? { endDate: resolvedEndDate } : {}),
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
    subEvent: allSubEvents,
    organizer: organizerBlock,
    // schema.org `performer` = confirmed ACTS (OPE-114) FIRST, then EXHIBITOR
    // vendors (the 2026-05-16 vendor mapping, drizzle/0071). `sponsor` stays the
    // vendor SPONSOR_ONLY / SPONSOR_AND_EXHIBITOR split. Both omitted when empty.
    // (K18 Phase 2: the top-level arrays carry SERIES-WIDE vendors only; per-day
    // vendors emit under their subEvent entry above.)
    performer: performerArray,
    sponsor: vendorSplit.sponsor,
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

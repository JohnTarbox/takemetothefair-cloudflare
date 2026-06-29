/**
 * EH3 P2 — schema.org builders for the Series + Occurrence model (pure).
 *
 * Two outputs, both standards-correct per the redesign spec §4.5:
 *   - `buildEventSeriesJsonLd(series, occurrences)` → a top-level `EventSeries`
 *     node (with `@context`) for the series landing page, carrying a `subEvent[]`
 *     of its occurrences.
 *   - `buildSuperEventRef(series)` → the embedded `superEvent` reference an
 *     occurrence's `Event` node points at (no `@context` — it's nested).
 *
 * URL scheme = locked Option A: the series landing is `/events/<canonical_slug>`
 * and an occurrence is `/events/<canonical_slug>/<year>` (self-canonical). An
 * occurrence with an unknown year falls back to its own event slug URL.
 *
 * Pure + side-effect-free — unit-tested ahead of the page wiring (P2.3), the same
 * way P1 led with pure modules. Callers pass already-resolved image URLs and
 * venue-zone ISO dates; this module only shapes JSON-LD.
 */
import { SITE_URL } from "@takemetothefair/constants";
import { buildPlaceJsonLd, type PlaceVenue } from "@/lib/seo/place-jsonld";
import { LIFECYCLE_TO_SCHEMA_ORG, type EventLifecycle } from "@/lib/event-lifecycle";

/**
 * OPE-18 (2026-06-29) — parent-derivation discipline for the WARNING-set
 * Google Event fields, applied to the EventSeries builder + every subEvent so
 * this layer reaches parity with the single-Event builder (EventSchema.tsx,
 * which already emits the full set). These helpers are pure and emit-when-known:
 * a field is only added when its source is populated, so "top-level wins" holds
 * by construction (a real value is never overwritten by a derived one).
 *
 * NOTE: the single-Event builder is the only one wired into a live page today;
 * buildEventSeriesJsonLd is built ahead of the P2.3 page wiring. This parity is
 * defensive — the EventSeries layer is compliant-by-construction the day it goes
 * live, instead of surfacing one GSC "Missing field X" warning at a time.
 */

/** A schema.org Organization for `organizer` (derived from the promoter row). */
export interface SchemaOrganizer {
  name: string;
  url?: string | null;
  logoUrl?: string | null;
}

/** `eventStatus` from `lifecycle_status` via the shared map. Returns undefined
 *  for past/unknown states (OCCURRED/NO_SHOW map to null) so the key is omitted
 *  rather than emitted empty. */
export function derivedEventStatus(lifecycleStatus?: string | null): string | undefined {
  if (!lifecycleStatus) return undefined;
  return LIFECYCLE_TO_SCHEMA_ORG[lifecycleStatus as EventLifecycle] ?? undefined;
}

/** `image` fallback chain (the OPE-18 default order, matching the brief):
 *  event/occurrence image → venue hero → promoter logo → series image. First
 *  non-empty wins; undefined when the whole chain is empty. */
export function derivedImage(...candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return undefined;
}

/** `organizer` Organization node from a promoter-derived shape. */
export function derivedOrganizer(
  org?: SchemaOrganizer | null
): Record<string, unknown> | undefined {
  if (!org || !org.name) return undefined;
  const node: Record<string, unknown> = { "@type": "Organization", name: org.name };
  if (org.url) node.url = org.url;
  if (org.logoUrl) node.logo = org.logoUrl;
  return node;
}

/** `offers` from ticket URL + integer-cents price fields. Mirrors the
 *  single-Event builder: AggregateOffer when min≠max, else a single Offer; both
 *  InStock. Emitted only when at least one price is known. */
export function derivedOffers(opts: {
  ticketUrl?: string | null;
  fallbackUrl?: string | null;
  priceMinCents?: number | null;
  priceMaxCents?: number | null;
}): Record<string, unknown> | undefined {
  const { ticketUrl, fallbackUrl, priceMinCents, priceMaxCents } = opts;
  const hasMin = priceMinCents !== null && priceMinCents !== undefined;
  const hasMax = priceMaxCents !== null && priceMaxCents !== undefined;
  if (!hasMin && !hasMax) return undefined;
  const min = hasMin ? priceMinCents! / 100 : null;
  const max = hasMax ? priceMaxCents! / 100 : null;
  const url = ticketUrl || fallbackUrl || undefined;
  if (min !== null && max !== null && min !== max) {
    return {
      "@type": "AggregateOffer",
      url,
      lowPrice: min,
      highPrice: max,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    };
  }
  return {
    "@type": "Offer",
    url,
    price: min ?? max ?? 0,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  };
}

export interface SeriesForSchema {
  canonicalSlug: string;
  name: string;
  description?: string | null;
  /** Absolute image URL (caller resolves; e.g. a cdn-cgi transform or og default). */
  imageUrl?: string | null;
  /**
   * K46 (2026-06-26) — representative venue for the series-level `location`
   * (the caller passes the hero occurrence's venue). Null/undefined emits the
   * "Location to be announced" Place so the required-field check still passes.
   */
  venue?: PlaceVenue | null;
  /**
   * K46 — series-level `startDate`/`endDate` (date-only ISO), from the hero
   * occurrence. Omitted when the hero is undated.
   */
  startDateIso?: string | null;
  endDateIso?: string | null;
  /**
   * OPE-18 — WARNING-set derivation sources (all optional; emit-when-known).
   * `lifecycleStatus` (hero occurrence's) → `eventStatus`; `organizer` (the
   * series promoter) → `organizer` and the subEvent organizer fallback;
   * `promoterLogoUrl`/`venueImageUrl` feed the subEvent image fallback chain.
   */
  lifecycleStatus?: string | null;
  organizer?: SchemaOrganizer | null;
  promoterLogoUrl?: string | null;
  venueImageUrl?: string | null;
}

export interface OccurrenceForSchema {
  /** The occurrence's own event slug — fallback URL when year is unknown. */
  slug: string;
  /** Edition year (from start date); null when undated. */
  year: number | null;
  name: string;
  /** ISO 8601 start/end, already formatted in the venue zone by the caller. */
  startDateIso?: string | null;
  endDateIso?: string | null;
  /**
   * K46 (2026-06-26) — the occurrence's venue, emitted as `subEvent[].location`.
   * Null/undefined emits "Location to be announced" so every subEvent carries a
   * location (Google flags a subEvent Event without one).
   */
  venue?: PlaceVenue | null;
  /**
   * OPE-18 — per-occurrence WARNING-set sources (all optional; emit-when-known).
   * `lifecycleStatus` → subEvent `eventStatus`; `imageUrl` heads the image
   * fallback chain; `description` → subEvent `description`; the ticket/price
   * fields → subEvent `offers`.
   */
  lifecycleStatus?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  ticketUrl?: string | null;
  ticketPriceMinCents?: number | null;
  ticketPriceMaxCents?: number | null;
}

/** `/events/<canonical_slug>` — the year-agnostic series landing URL. */
export function seriesUrl(canonicalSlug: string): string {
  return `${SITE_URL}/events/${canonicalSlug}`;
}

/**
 * `/events/<canonical_slug>/<year>` — the per-year occurrence URL (Option A).
 * Falls back to `/events/<slug>` when the year is unknown.
 */
export function occurrenceUrl(
  canonicalSlug: string,
  year: number | null,
  fallbackSlug: string
): string {
  return year === null
    ? `${SITE_URL}/events/${fallbackSlug}`
    : `${SITE_URL}/events/${canonicalSlug}/${year}`;
}

function occurrenceNode(series: SeriesForSchema, occ: OccurrenceForSchema) {
  const node: Record<string, unknown> = {
    "@type": "Event",
    name: occ.name,
    url: occurrenceUrl(series.canonicalSlug, occ.year, occ.slug),
  };
  if (occ.startDateIso) node.startDate = occ.startDateIso;
  if (occ.endDateIso) node.endDate = occ.endDateIso;
  // K46 — every subEvent Event needs a `location` or Google Rich Results
  // flags it. Falls back to "Location to be announced" when undated/venueless.
  node.location = buildPlaceJsonLd(occ.venue ?? null);

  // OPE-18 — WARNING-set parity on each subEvent (the nodes Google validates as
  // Events). Each is emit-when-known so a real top-level value is never
  // overwritten by a derived one.
  const eventStatus = derivedEventStatus(occ.lifecycleStatus);
  if (eventStatus) node.eventStatus = eventStatus;
  if (occ.description) node.description = occ.description;
  // image fallback chain: occurrence image → venue hero → promoter logo → series image.
  const image = derivedImage(
    occ.imageUrl,
    series.venueImageUrl,
    series.promoterLogoUrl,
    series.imageUrl
  );
  if (image) node.image = image;
  const organizer = derivedOrganizer(series.organizer);
  if (organizer) node.organizer = organizer;
  const offers = derivedOffers({
    ticketUrl: occ.ticketUrl,
    fallbackUrl: node.url as string,
    priceMinCents: occ.ticketPriceMinCents,
    priceMaxCents: occ.ticketPriceMaxCents,
  });
  if (offers) node.offers = offers;
  return node;
}

/**
 * Top-level `EventSeries` JSON-LD for the series landing page. `subEvent` is
 * omitted entirely when there are no occurrences (rather than an empty array).
 */
export function buildEventSeriesJsonLd(
  series: SeriesForSchema,
  occurrences: OccurrenceForSchema[]
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "EventSeries",
    name: series.name,
    url: seriesUrl(series.canonicalSlug),
  };
  // K46 — top-level `location` (required by Google Rich Results; its absence
  // was the 360-error "Missing field location" on every series page) plus
  // `startDate`/`endDate` from the hero occurrence. location is always emitted
  // (falls back to "Location to be announced") so the required field is never
  // missing.
  node.location = buildPlaceJsonLd(series.venue ?? null);
  if (series.startDateIso) node.startDate = series.startDateIso;
  if (series.endDateIso) node.endDate = series.endDateIso;
  if (series.description) node.description = series.description;
  if (series.imageUrl) node.image = series.imageUrl;
  // OPE-18 — series-level WARNING-set parity. eventStatus from the hero
  // occurrence's lifecycle; organizer from the series promoter. (offers/
  // performer are per-occurrence concerns, not series-level — intentionally
  // omitted here.)
  const eventStatus = derivedEventStatus(series.lifecycleStatus);
  if (eventStatus) node.eventStatus = eventStatus;
  const organizer = derivedOrganizer(series.organizer);
  if (organizer) node.organizer = organizer;
  if (occurrences.length > 0) {
    node.subEvent = occurrences.map((o) => occurrenceNode(series, o));
  }
  return node;
}

/**
 * Embedded `superEvent` reference for an occurrence's `Event` node. No
 * `@context` — it nests inside the occurrence's own top-level Event schema.
 */
export function buildSuperEventRef(series: SeriesForSchema): Record<string, unknown> {
  return {
    "@type": "EventSeries",
    name: series.name,
    url: seriesUrl(series.canonicalSlug),
  };
}

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

export interface SeriesForSchema {
  canonicalSlug: string;
  name: string;
  description?: string | null;
  /** Absolute image URL (caller resolves; e.g. a cdn-cgi transform or og default). */
  imageUrl?: string | null;
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
  if (series.description) node.description = series.description;
  if (series.imageUrl) node.image = series.imageUrl;
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

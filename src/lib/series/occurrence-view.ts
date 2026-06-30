/**
 * EH3 P2.2 — pure view-model logic for the series landing page.
 *
 * Turns a series' occurrence rows (the `events` with this `series_id`) into the
 * shapes the landing renders: a HERO occurrence (next/current, else most recent
 * past) and a PAST-YEARS list, plus the schema.org occurrence inputs. Pure +
 * side-effect-free — the DB query (`getSeriesLanding`) and venue-zone date
 * formatting are P2.3 glue; the selection/partition judgment lives here so it's
 * unit-tested in isolation (same pattern as the rest of src/lib/series/).
 */
import type { OccurrenceForSchema } from "./series-schema-org";
import type { PlaceVenue } from "@/lib/seo/place-jsonld";

/** Minimal occurrence shape — a public, non-tombstone event under the series. */
export interface OccurrenceRow {
  id: string;
  slug: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  /** K46 — the occurrence's venue, threaded into `subEvent[].location`. */
  venue?: PlaceVenue | null;
  /**
   * OPE-27 — the occurrence's own `events.image_url`. Lets the series landing
   * inherit a hero image from its hero occurrence when the `event_series` row
   * has none (`event_series.image_url` is commonly NULL after backfill).
   */
  imageUrl?: string | null;
}

export interface OccurrenceView extends OccurrenceRow {
  /** Edition year from startDate (UTC); null when undated. */
  year: number | null;
  /** True when the occurrence's effective end is in the past. */
  isPast: boolean;
}

function occYear(o: OccurrenceRow): number | null {
  return o.startDate ? o.startDate.getUTCFullYear() : null;
}

/** Effective end for past/upcoming classification: endDate, else startDate. */
function effectiveEnd(o: OccurrenceRow): Date | null {
  return o.endDate ?? o.startDate ?? null;
}

function toView(o: OccurrenceRow, now: Date): OccurrenceView {
  const end = effectiveEnd(o);
  return { ...o, year: occYear(o), isPast: end !== null && end.getTime() < now.getTime() };
}

/** Ascending by start (nulls last), then id — stable. */
function byStartAsc(a: OccurrenceRow, b: OccurrenceRow): number {
  const at = a.startDate?.getTime() ?? null;
  const bt = b.startDate?.getTime() ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return at - bt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Partition occurrences into `current` (upcoming/ongoing/undated, soonest first)
 * and `past` (ended, most-recent first). Pure; does not mutate input.
 */
export function partitionOccurrences(
  occurrences: OccurrenceRow[],
  now: Date
): { current: OccurrenceView[]; past: OccurrenceView[] } {
  const views = occurrences.map((o) => toView(o, now));
  const current = views.filter((v) => !v.isPast).sort(byStartAsc);
  const past = views.filter((v) => v.isPast).sort((a, b) => byStartAsc(b, a)); // desc
  return { current, past };
}

/**
 * The landing hero: the soonest current/upcoming occurrence, else the most
 * recent past one. Null only when the series has no occurrences.
 */
export function pickHeroOccurrence(occurrences: OccurrenceRow[], now: Date): OccurrenceView | null {
  const { current, past } = partitionOccurrences(occurrences, now);
  return current[0] ?? past[0] ?? null;
}

/**
 * Map occurrences to schema.org `subEvent` inputs (chronological). Emits date-
 * only ISO from the UTC Date; P2.3 may substitute venue-zone formatting, which
 * is why the caller owns the final EventSchema wiring.
 */
export function toSchemaOccurrences(occurrences: OccurrenceRow[]): OccurrenceForSchema[] {
  return [...occurrences].sort(byStartAsc).map((o) => ({
    slug: o.slug,
    year: occYear(o),
    name: o.name,
    startDateIso: o.startDate ? o.startDate.toISOString().slice(0, 10) : null,
    endDateIso: o.endDate ? o.endDate.toISOString().slice(0, 10) : null,
    venue: o.venue ?? null,
  }));
}

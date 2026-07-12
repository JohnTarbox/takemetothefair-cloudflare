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
  /**
   * OPE-18 — JSON-LD WARNING-set sources, threaded into each subEvent by
   * toSchemaOccurrences: `lifecycleStatus` → `eventStatus`, `description` →
   * subEvent `description`, ticket fields → subEvent `offers`.
   */
  lifecycleStatus?: string | null;
  description?: string | null;
  ticketUrl?: string | null;
  ticketPriceMinCents?: number | null;
  ticketPriceMaxCents?: number | null;
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
 * OPE-182 — read-through for the drift-prone denormalized `event_series` columns.
 *
 * `event_series.description` and `.image_url` are write-once backfill SNAPSHOTS:
 * the backfill copies them verbatim from one "defaults member" occurrence and
 * nothing ever updates them, so when that event is later edited the series
 * landing (its JSON-LD, og:image, and on-page hero) keeps serving the stale copy.
 * There is no editorial UI that sets these independently, so there is no
 * deliberate series-level value to protect — prefer the LIVE hero occurrence's
 * value, falling back to the series snapshot only when the hero has none.
 *
 * `name` is intentionally NOT read through: the backfill stores a *canonical*
 * year-stripped series name (`stripNameEditionSuffix`), which must not be
 * replaced by an occurrence's yeared name (e.g. "… 2025") on a multi-year series.
 *
 * Uses first-non-empty (not `??`) so an empty-string snapshot/occurrence value is
 * treated as absent, matching how the rest of the schema layer handles blanks.
 */
export function resolveSeriesLandingContent(
  seriesSnapshot: { description: string | null; imageUrl: string | null },
  hero: Pick<OccurrenceRow, "description" | "imageUrl"> | null
): { description: string | null; imageUrl: string | null } {
  const firstNonEmpty = (...vals: Array<string | null | undefined>): string | null => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    return null;
  };
  return {
    description: firstNonEmpty(hero?.description, seriesSnapshot.description),
    imageUrl: firstNonEmpty(hero?.imageUrl, seriesSnapshot.imageUrl),
  };
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
    // OPE-18 — pass the WARNING-set sources through to the builder (emit-when-known).
    imageUrl: o.imageUrl ?? null,
    lifecycleStatus: o.lifecycleStatus ?? null,
    description: o.description ?? null,
    ticketUrl: o.ticketUrl ?? null,
    ticketPriceMinCents: o.ticketPriceMinCents ?? null,
    ticketPriceMaxCents: o.ticketPriceMaxCents ?? null,
  }));
}

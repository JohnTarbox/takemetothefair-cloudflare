/**
 * EH3 P2.5 — group a vendor's events into a "Shows by year" timeline.
 *
 * Events that belong to a series collapse into one entry per series with a
 * descending list of years; events with no series stay standalone (today's
 * one-row-each behavior). Pure + unit-tested; the vendor page renders the result.
 * Until the P1 backfill links events, every event has seriesId = null, so this
 * returns all-standalone and the timeline section renders nothing.
 */
import { editionKeyFor, occurrencePath, occurrenceYear } from "@takemetothefair/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export interface VendorShowInput {
  seriesId: string | null;
  seriesSlug: string | null;
  seriesName: string | null;
  /** OPE-1326 — required: the series' mode and the member's key decide the chip's URL. */
  editionMode: string | null;
  editionKey: string | null;
  eventSlug: string;
  eventName: string;
  startDate: Date | null;
}

export interface VendorShowYear {
  year: number | null;
  /**
   * OPE-1326 — the chip's href, from the shared builder: the year page, the
   * EDITION page on a multi-edition series, or the event's own slug if undated.
   */
  path: string;
  /** "2026", or "May 2027" for an edition, or "—" when undated. */
  label: string;
  eventSlug: string;
  eventName: string;
  startDate: Date | null;
}

export interface VendorShowSeries {
  seriesSlug: string;
  seriesName: string;
  /** Occurrences this vendor did under the series, most recent year first. */
  years: VendorShowYear[];
}

export function groupVendorShows(items: VendorShowInput[]): {
  series: VendorShowSeries[];
  standalone: VendorShowInput[];
} {
  const bySeries = new Map<string, VendorShowSeries>();
  const standalone: VendorShowInput[] = [];

  for (const it of items) {
    if (it.seriesId && it.seriesSlug && it.seriesName) {
      const g = bySeries.get(it.seriesSlug) ?? {
        seriesSlug: it.seriesSlug,
        seriesName: it.seriesName,
        years: [],
      };
      const year = occurrenceYear(it.startDate);
      const key = editionKeyFor(it);
      g.years.push({
        year,
        path: occurrencePath(it.seriesSlug, it.startDate, it) ?? `/events/${it.eventSlug}`,
        label: key
          ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`
          : year != null
            ? String(year)
            : "—",
        eventSlug: it.eventSlug,
        eventName: it.eventName,
        startDate: it.startDate,
      });
      bySeries.set(it.seriesSlug, g);
    } else {
      standalone.push(it);
    }
  }

  const series = [...bySeries.values()]
    .map((s) => ({
      ...s,
      // Most recent first; undated sorts last. OPE-1326 — ties within a year
      // break on start date, so two editions of one year list October, then May.
      years: [...s.years].sort(
        (a, b) =>
          (b.year ?? -Infinity) - (a.year ?? -Infinity) ||
          (b.startDate?.getTime() ?? 0) - (a.startDate?.getTime() ?? 0)
      ),
    }))
    .sort((a, b) => a.seriesName.localeCompare(b.seriesName));

  return { series, standalone };
}

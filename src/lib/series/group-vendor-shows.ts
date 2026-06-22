/**
 * EH3 P2.5 — group a vendor's events into a "Shows by year" timeline.
 *
 * Events that belong to a series collapse into one entry per series with a
 * descending list of years; events with no series stay standalone (today's
 * one-row-each behavior). Pure + unit-tested; the vendor page renders the result.
 * Until the P1 backfill links events, every event has seriesId = null, so this
 * returns all-standalone and the timeline section renders nothing.
 */
export interface VendorShowInput {
  seriesId: string | null;
  seriesSlug: string | null;
  seriesName: string | null;
  eventSlug: string;
  eventName: string;
  startDate: Date | null;
}

export interface VendorShowYear {
  year: number | null;
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
      g.years.push({
        year: it.startDate ? it.startDate.getUTCFullYear() : null,
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
      // Most recent year first; undated (null year) sorts last.
      years: [...s.years].sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity)),
    }))
    .sort((a, b) => a.seriesName.localeCompare(b.seriesName));

  return { series, standalone };
}

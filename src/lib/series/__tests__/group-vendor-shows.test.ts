import { describe, it, expect } from "vitest";
import { groupVendorShows, type VendorShowInput } from "../group-vendor-shows";

const item = (over: Partial<VendorShowInput> & { eventSlug: string }): VendorShowInput => ({
  seriesId: null,
  seriesSlug: null,
  seriesName: null,
  eventName: "Event",
  startDate: null,
  ...over,
});

const dated = (slug: string, y: number, series?: { id: string; slug: string; name: string }) =>
  item({
    eventSlug: slug,
    startDate: new Date(Date.UTC(y, 0, 1)),
    seriesId: series?.id ?? null,
    seriesSlug: series?.slug ?? null,
    seriesName: series?.name ?? null,
  });

const NEWPORT = { id: "s1", slug: "newport-boat-show", name: "Newport Boat Show" };

describe("groupVendorShows", () => {
  it("keeps non-series events standalone (today's behavior)", () => {
    const { series, standalone } = groupVendorShows([dated("a-fair-2026", 2026)]);
    expect(series).toEqual([]);
    expect(standalone.map((s) => s.eventSlug)).toEqual(["a-fair-2026"]);
  });

  it("collapses a series' occurrences into one entry, years descending", () => {
    const { series, standalone } = groupVendorShows([
      dated("newport-2025", 2025, NEWPORT),
      dated("newport-2027", 2027, NEWPORT),
      dated("newport-2026", 2026, NEWPORT),
    ]);
    expect(standalone).toEqual([]);
    expect(series).toHaveLength(1);
    expect(series[0].seriesSlug).toBe("newport-boat-show");
    expect(series[0].years.map((y) => y.year)).toEqual([2027, 2026, 2025]);
  });

  it("separates series shows from standalone shows", () => {
    const { series, standalone } = groupVendorShows([
      dated("newport-2026", 2026, NEWPORT),
      dated("one-off-2026", 2026),
    ]);
    expect(series.map((s) => s.seriesSlug)).toEqual(["newport-boat-show"]);
    expect(standalone.map((s) => s.eventSlug)).toEqual(["one-off-2026"]);
  });

  it("sorts multiple series alphabetically by name", () => {
    const ZEBRA = { id: "s2", slug: "zebra-expo", name: "Zebra Expo" };
    const { series } = groupVendorShows([
      dated("zebra-2026", 2026, ZEBRA),
      dated("newport-2026", 2026, NEWPORT),
    ]);
    expect(series.map((s) => s.seriesName)).toEqual(["Newport Boat Show", "Zebra Expo"]);
  });

  it("treats a series link missing slug/name as standalone (defensive)", () => {
    const { series, standalone } = groupVendorShows([
      item({ eventSlug: "x-2026", seriesId: "s9", seriesSlug: null, seriesName: null }),
    ]);
    expect(series).toEqual([]);
    expect(standalone).toHaveLength(1);
  });
});

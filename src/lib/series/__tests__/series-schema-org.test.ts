import { describe, it, expect } from "vitest";
import {
  seriesUrl,
  occurrenceUrl,
  buildEventSeriesJsonLd,
  buildSuperEventRef,
  type SeriesForSchema,
  type OccurrenceForSchema,
} from "../series-schema-org";

const SITE = "https://meetmeatthefair.com";

const series: SeriesForSchema = {
  canonicalSlug: "newport-international-boat-show",
  name: "Newport International Boat Show",
};

const occ = (over: Partial<OccurrenceForSchema> & { slug: string }): OccurrenceForSchema => ({
  year: 2025,
  name: "Newport International Boat Show",
  ...over,
});

describe("series/occurrence URLs", () => {
  it("seriesUrl is the year-agnostic landing path", () => {
    expect(seriesUrl("newport-international-boat-show")).toBe(
      `${SITE}/events/newport-international-boat-show`
    );
  });
  it("occurrenceUrl uses /<series>/<year> when the year is known", () => {
    expect(occurrenceUrl("newport-international-boat-show", 2025, "fallback-slug")).toBe(
      `${SITE}/events/newport-international-boat-show/2025`
    );
  });
  it("occurrenceUrl falls back to the event slug when the year is unknown", () => {
    expect(occurrenceUrl("newport-international-boat-show", null, "newport-2025-legacy")).toBe(
      `${SITE}/events/newport-2025-legacy`
    );
  });
});

describe("buildEventSeriesJsonLd", () => {
  it("emits a top-level EventSeries with @context and url", () => {
    const ld = buildEventSeriesJsonLd(series, []);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("EventSeries");
    expect(ld.name).toBe("Newport International Boat Show");
    expect(ld.url).toBe(`${SITE}/events/newport-international-boat-show`);
  });

  it("omits subEvent entirely when there are no occurrences", () => {
    expect(buildEventSeriesJsonLd(series, [])).not.toHaveProperty("subEvent");
  });

  it("builds subEvent nodes with Option-A occurrence URLs + dates", () => {
    const ld = buildEventSeriesJsonLd(series, [
      occ({
        slug: "newport-2025",
        year: 2025,
        startDateIso: "2025-09-11",
        endDateIso: "2025-09-14",
      }),
      occ({ slug: "newport-2026", year: 2026 }),
    ]);
    const sub = ld.subEvent as Array<Record<string, unknown>>;
    expect(sub).toHaveLength(2);
    expect(sub[0]).toMatchObject({
      "@type": "Event",
      url: `${SITE}/events/newport-international-boat-show/2025`,
      startDate: "2025-09-11",
      endDate: "2025-09-14",
    });
    // second occurrence has no dates → those keys are absent
    expect(sub[1]).not.toHaveProperty("startDate");
    expect(sub[1].url).toBe(`${SITE}/events/newport-international-boat-show/2026`);
  });

  it("includes description and image only when present", () => {
    const bare = buildEventSeriesJsonLd(series, []);
    expect(bare).not.toHaveProperty("description");
    expect(bare).not.toHaveProperty("image");

    const rich = buildEventSeriesJsonLd(
      { ...series, description: "Annual boat show", imageUrl: "https://img/x.jpg" },
      []
    );
    expect(rich.description).toBe("Annual boat show");
    expect(rich.image).toBe("https://img/x.jpg");
  });
});

describe("buildSuperEventRef", () => {
  it("emits a nested EventSeries reference without @context", () => {
    const ref = buildSuperEventRef(series);
    expect(ref).toEqual({
      "@type": "EventSeries",
      name: "Newport International Boat Show",
      url: `${SITE}/events/newport-international-boat-show`,
    });
    expect(ref).not.toHaveProperty("@context");
  });
});

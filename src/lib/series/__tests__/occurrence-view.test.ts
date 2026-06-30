import { describe, it, expect } from "vitest";
import {
  partitionOccurrences,
  pickHeroOccurrence,
  toSchemaOccurrences,
  type OccurrenceRow,
} from "../occurrence-view";

const NOW = new Date(Date.UTC(2026, 5, 21)); // 2026-06-21

const occ = (over: Partial<OccurrenceRow> & { id: string }): OccurrenceRow => ({
  slug: `${over.id}-slug`,
  name: "Occurrence",
  startDate: null,
  endDate: null,
  ...over,
});

// Helper to build a dated occurrence (single-day).
const dated = (id: string, y: number, m = 8, d = 1): OccurrenceRow =>
  occ({ id, startDate: new Date(Date.UTC(y, m, d)), endDate: new Date(Date.UTC(y, m, d + 2)) });

describe("partitionOccurrences", () => {
  it("splits into current (asc) and past (desc by start)", () => {
    const { current, past } = partitionOccurrences(
      [dated("a", 2025), dated("c", 2027), dated("b", 2024), dated("u", 2026, 7, 1)],
      NOW
    );
    // 2026 (July, future) + 2027 are current, soonest first
    expect(current.map((v) => v.id)).toEqual(["u", "c"]);
    // 2025 + 2024 are past, most recent first
    expect(past.map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("treats undated occurrences as current (not past)", () => {
    const { current, past } = partitionOccurrences([occ({ id: "x" })], NOW);
    expect(current.map((v) => v.id)).toEqual(["x"]);
    expect(past).toEqual([]);
  });

  it("classifies an in-progress occurrence (ends today/future) as current", () => {
    const ongoing = occ({
      id: "live",
      startDate: new Date(Date.UTC(2026, 5, 20)),
      endDate: new Date(Date.UTC(2026, 5, 23)),
    });
    const { current } = partitionOccurrences([ongoing], NOW);
    expect(current.map((v) => v.id)).toEqual(["live"]);
  });

  it("does not mutate the input array", () => {
    const input = [dated("a", 2027), dated("b", 2024)];
    const order = input.map((o) => o.id);
    partitionOccurrences(input, NOW);
    expect(input.map((o) => o.id)).toEqual(order);
  });
});

describe("pickHeroOccurrence", () => {
  it("prefers the soonest current/upcoming occurrence", () => {
    const hero = pickHeroOccurrence(
      [dated("past", 2024), dated("soon", 2026, 9, 1), dated("later", 2027)],
      NOW
    );
    expect(hero?.id).toBe("soon");
  });

  it("falls back to the most recent past when nothing is upcoming", () => {
    const hero = pickHeroOccurrence([dated("old", 2023), dated("recent", 2025)], NOW);
    expect(hero?.id).toBe("recent");
    expect(hero?.isPast).toBe(true);
  });

  it("returns null for a series with no occurrences", () => {
    expect(pickHeroOccurrence([], NOW)).toBeNull();
  });
});

describe("toSchemaOccurrences", () => {
  it("maps chronologically with year + date-only ISO", () => {
    const out = toSchemaOccurrences([dated("b", 2026), dated("a", 2025)]);
    expect(out.map((o) => o.year)).toEqual([2025, 2026]); // sorted asc
    expect(out[0]).toMatchObject({
      slug: "a-slug",
      year: 2025,
      startDateIso: "2025-09-01",
      endDateIso: "2025-09-03",
    });
  });

  it("emits null dates for undated occurrences", () => {
    const [o] = toSchemaOccurrences([occ({ id: "x" })]);
    expect(o.year).toBeNull();
    expect(o.startDateIso).toBeNull();
    expect(o.endDateIso).toBeNull();
  });

  it("passes the occurrence venue through for subEvent[].location (K46)", () => {
    const venue = { name: "Newport Yachting Center", city: "Newport", state: "RI" };
    const [withVenue] = toSchemaOccurrences([occ({ id: "x", venue })]);
    expect(withVenue.venue).toEqual(venue);
    // Absent venue normalises to null (→ "Location to be announced" downstream).
    const [withoutVenue] = toSchemaOccurrences([occ({ id: "y" })]);
    expect(withoutVenue.venue).toBeNull();
  });

  it("threads the WARNING-set sources through to the subEvent inputs (OPE-18)", () => {
    const [o] = toSchemaOccurrences([
      occ({
        id: "x",
        imageUrl: "https://cdn/img.webp",
        lifecycleStatus: "SCHEDULED",
        description: "A coin show.",
        ticketUrl: "https://tix",
        ticketPriceMinCents: 500,
        ticketPriceMaxCents: 1000,
      }),
    ]);
    expect(o).toMatchObject({
      imageUrl: "https://cdn/img.webp",
      lifecycleStatus: "SCHEDULED",
      description: "A coin show.",
      ticketUrl: "https://tix",
      ticketPriceMinCents: 500,
      ticketPriceMaxCents: 1000,
    });
  });

  it("normalises absent WARNING-set sources to null (emit-when-known)", () => {
    const [o] = toSchemaOccurrences([occ({ id: "y" })]);
    expect(o.lifecycleStatus).toBeNull();
    expect(o.description).toBeNull();
    expect(o.ticketPriceMinCents).toBeNull();
  });
});

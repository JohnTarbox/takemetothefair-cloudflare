/**
 * OPE-1479 — the "Visiting" box: every line says where its answer comes from,
 * Google's options are the BUILDING's, and nothing is inferred.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveVisitingLines, type VisitingInput } from "@/lib/events/visiting";
import { googleAmenityPhrases, GOOGLE_PARKING_LABELS } from "@/lib/venues/google-amenities";

// Augusta Civic Center's shape (the acceptance specimen's venue).
const AUGUSTA_ACCESS = JSON.stringify({
  wheelchairAccessibleEntrance: true,
  wheelchairAccessibleParking: true,
  wheelchairAccessibleRestroom: true,
  wheelchairAccessibleSeating: true,
});
const AUGUSTA_PARKING = JSON.stringify({ freeParkingLot: true });

function input(over: Partial<VisitingInput> = {}): VisitingInput {
  return {
    petFriendly: "UNSET",
    petCitedOn: null,
    venueAccessibility: null,
    venueParking: null,
    venuePetFriendly: null,
    placeholderPromoter: false,
    ...over,
  };
}

describe("resolveVisitingLines", () => {
  it("venue-only state: Augusta Civic Center's Google options, labelled as the venue's", () => {
    const lines = resolveVisitingLines(
      input({ venueAccessibility: AUGUSTA_ACCESS, venueParking: AUGUSTA_PARKING })
    );
    expect(lines[0]).toEqual({
      topic: "parking",
      source: "venue_google",
      phrases: ["Free parking lot"],
    });
    expect(lines[1]).toMatchObject({ topic: "accessibility", source: "venue_google" });
    expect((lines[1] as { phrases: string[] }).phrases).toContain("Wheelchair accessible entrance");
    expect(lines[2]).toEqual({
      topic: "pets",
      source: "unknown",
      text: "Not published by the organizer.",
    });
  });

  it("organizer state: pet_friendly YES/NO is organizer-published, with its citation date", () => {
    const d = new Date("2026-10-01T12:00:00Z");
    expect(resolveVisitingLines(input({ petFriendly: "YES", petCitedOn: d }))[2]).toEqual({
      topic: "pets",
      source: "organizer",
      text: "Pets allowed, per the organizer",
      citedOn: d,
    });
    // NO never renders as a bare "No" (OPE-1061 rule 2).
    expect(resolveVisitingLines(input({ petFriendly: "NO" }))[2]).toMatchObject({
      text: "Service animals only — no pets",
    });
  });

  it("unknown state: nothing held → all three lines say so", () => {
    const lines = resolveVisitingLines(input());
    expect(lines.map((l) => l.source)).toEqual(["unknown", "unknown", "unknown"]);
    expect(lines.every((l) => "text" in l && l.text === "Not published by the organizer.")).toBe(
      true
    );
  });

  it("NOT_PUBLISHED is unknown, never a no", () => {
    expect(resolveVisitingLines(input({ petFriendly: "NOT_PUBLISHED" }))[2].source).toBe("unknown");
  });

  it("venue pet rule: shown as the VENUE's, only when the event's own value is UNSET", () => {
    // UNSET and NULL both mean nobody has looked at the event → the venue's rule shows.
    for (const petFriendly of ["UNSET", null, undefined]) {
      expect(resolveVisitingLines(input({ petFriendly, venuePetFriendly: "NO" }))[2]).toEqual({
        topic: "pets",
        source: "venue_rule",
        text: "At this venue: service animals only — no pets",
      });
    }
    expect(resolveVisitingLines(input({ venuePetFriendly: "YES" }))[2]).toMatchObject({
      source: "venue_rule",
      text: "At this venue: pets generally allowed",
    });
    // The event's own answer always wins — even when it disagrees with the venue.
    expect(
      resolveVisitingLines(input({ petFriendly: "YES", venuePetFriendly: "NO" }))[2]
    ).toMatchObject({ source: "organizer", text: "Pets allowed, per the organizer" });
    // NOT_PUBLISHED = we looked and the organizer is silent: the building's rule
    // must not stand in for the event's.
    expect(
      resolveVisitingLines(input({ petFriendly: "NOT_PUBLISHED", venuePetFriendly: "NO" }))[2]
        .source
    ).toBe("unknown");
    // A venue value that is itself UNSET / NOT_PUBLISHED adds nothing.
    for (const venuePetFriendly of ["UNSET", "NOT_PUBLISHED", null]) {
      expect(resolveVisitingLines(input({ venuePetFriendly }))[2].source).toBe("unknown");
    }
  });

  it("placeholder promoter: 'Not published.' with no organizer named", () => {
    const lines = resolveVisitingLines(input({ placeholderPromoter: true }));
    expect(lines.every((l) => "text" in l && l.text === "Not published.")).toBe(true);
  });

  it("only true flags become phrases; false / malformed / non-object read as nothing", () => {
    expect(
      googleAmenityPhrases(
        JSON.stringify({ freeParkingLot: false, paidStreetParking: true }),
        GOOGLE_PARKING_LABELS
      )
    ).toEqual(["Paid street parking"]);
    expect(googleAmenityPhrases("{not json", GOOGLE_PARKING_LABELS)).toEqual([]);
    expect(googleAmenityPhrases("[true]", GOOGLE_PARKING_LABELS)).toEqual([]);
    const lines = resolveVisitingLines(input({ venueParking: JSON.stringify({ x: false }) }));
    expect(lines[0].source).toBe("unknown");
  });
});

describe("no inference (OPE-1479 acceptance: grep the renderer)", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/events/visiting.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("the resolver reads no category, type, scale, series or sibling input", () => {
    expect(code).not.toMatch(/categor|eventType|event_type|eventScale|series|sibling|year/i);
    // Positive landmark: the three stored inputs ARE read.
    expect(code).toMatch(/input\.petFriendly/);
    expect(code).toMatch(/input\.venueParking/);
    expect(code).toMatch(/input\.venueAccessibility/);
  });
});

describe("event page wiring (OPE-1479)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/events/[slug]/page.tsx"), "utf8");

  it("reads venue facts via getVisitingFacts, never the lite venue projection", () => {
    expect(page).toMatch(/getVisitingFacts\(getCloudflareDb\(\), event\.id, event\.venueId\)/);
    expect(page).not.toMatch(/event\.venue\??\.(parking|accessibility)/);
  });

  it("labels Google data as the venue's, and sits above the question card", () => {
    expect(page).toContain("About the venue (from Google):");
    const visiting = page.indexOf("data-visiting");
    const question = page.indexOf("Question about this event?</h3>");
    expect(visiting).toBeGreaterThan(0);
    expect(question).toBeGreaterThan(visiting);
  });
});

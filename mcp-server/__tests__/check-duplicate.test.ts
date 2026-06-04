import { describe, it, expect } from "vitest";
import { parseResponse } from "../src/duplicates/check-duplicate";

describe("parseResponse", () => {
  it("returns isDuplicate:false on null/undefined", () => {
    expect(parseResponse(null)).toEqual({ isDuplicate: false });
    expect(parseResponse(undefined)).toEqual({ isDuplicate: false });
  });

  it("returns isDuplicate:false when isDuplicate is missing or false", () => {
    expect(parseResponse({})).toEqual({ isDuplicate: false });
    expect(parseResponse({ isDuplicate: false })).toEqual({ isDuplicate: false });
  });

  it("returns isDuplicate:false on unknown matchType (fail-soft, not fabricated)", () => {
    expect(
      parseResponse({
        isDuplicate: true,
        matchType: "made_up_kind",
        existingEvent: { id: "x", slug: "y", name: "z", status: "APPROVED" },
      })
    ).toEqual({ isDuplicate: false });
  });

  it("parses a venue_date match into typed shape", () => {
    const r = parseResponse({
      isDuplicate: true,
      matchType: "venue_date",
      existingEvent: {
        id: "4ee1de4a-1234",
        slug: "winthrop-arts-festival-2026",
        name: "Winthrop Arts Festival 2026",
        startDate: "2026-08-15T12:00:00.000Z",
        status: "APPROVED",
        sourceUrl: "https://example.com/winthrop",
      },
    });
    expect(r.isDuplicate).toBe(true);
    if (r.isDuplicate) {
      expect(r.matchType).toBe("venue_date");
      expect(r.existingEvent.id).toBe("4ee1de4a-1234");
      expect(r.existingEvent.startDate).toBeInstanceOf(Date);
      expect(r.existingEvent.startDate?.toISOString()).toBe("2026-08-15T12:00:00.000Z");
    }
  });

  it("includes similarity on similar_name_date matches", () => {
    const r = parseResponse({
      isDuplicate: true,
      matchType: "similar_name_date",
      similarity: 0.94,
      existingEvent: {
        id: "abc",
        slug: "foo",
        name: "Foo",
        startDate: null,
        status: "APPROVED",
        sourceUrl: null,
      },
    });
    expect(r.isDuplicate && r.similarity).toBe(0.94);
  });

  it("tolerates missing startDate (null) on the existing event", () => {
    const r = parseResponse({
      isDuplicate: true,
      matchType: "exact_url",
      existingEvent: {
        id: "x",
        slug: "y",
        name: "z",
        startDate: null,
        status: "APPROVED",
        sourceUrl: "https://example.com",
      },
    });
    expect(r.isDuplicate).toBe(true);
    if (r.isDuplicate) expect(r.existingEvent.startDate).toBeNull();
  });

  it("tolerates Invalid Date strings (returns startDate:null, not garbage)", () => {
    const r = parseResponse({
      isDuplicate: true,
      matchType: "exact_url",
      existingEvent: {
        id: "x",
        slug: "y",
        name: "z",
        startDate: "not-a-date",
        status: "APPROVED",
        sourceUrl: null,
      },
    });
    expect(r.isDuplicate).toBe(true);
    if (r.isDuplicate) expect(r.existingEvent.startDate).toBeNull();
  });
});

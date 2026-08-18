/**
 * OPE-433 scope 4 — provenance for `venues` and `event_days`.
 *
 * The two tables with no source, no ingestion method and no verified-at are the
 * two where the defects cluster: both logged fabricated-fact instances live in
 * `event_days` (MDI's invented 10-5/10-4/10-3 hours against a published flat
 * 9-4, and OPE-411's 09:00–18:00 rows).
 */
import { describe, expect, it } from "vitest";
import {
  buildEntityCitations,
  isCiteableValue,
  toCitationFields,
  CITABLE_FIELDS,
} from "./entity-citation";

const NOW = new Date("2026-08-18T20:00:00Z");
const SOURCE = {
  sourceUrl: "https://islandartsassociation.com/upcoming-fairs/",
  sourceName: "islandartsassociation.com",
  sourceType: "official_website" as const,
};

describe("the MDI hours specimen", () => {
  it("attributes the hours a source actually published", () => {
    const rows = buildEntityCitations(
      "EVENT_DAY",
      "day-1",
      toCitationFields({ date: "2026-10-10", openTime: "09:00", closeTime: "16:00" }),
      SOURCE,
      NOW
    );
    expect(rows.map((r) => r.fieldName).sort()).toEqual(["close_time", "date", "open_time"]);
    expect(rows.every((r) => r.sourceUrl === SOURCE.sourceUrl)).toBe(true);
    expect(rows.every((r) => r.state === "active")).toBe(true);
  });

  it("uses snake_case field names, so evidence for one field lands in one bucket", () => {
    // If the app cited `openTime` and MCP cited `open_time`, one field's
    // evidence would split across two names and both halves would look thinner
    // than the truth.
    const rows = buildEntityCitations(
      "EVENT_DAY",
      "day-1",
      toCitationFields({ openTime: "09:00" }),
      SOURCE,
      NOW
    );
    expect(rows[0].fieldName).toBe("open_time");
  });
});

describe("an empty value is not a claim", () => {
  it("drops null, undefined and blank", () => {
    const rows = buildEntityCitations(
      "VENUE",
      "v1",
      { address: null, city: undefined, zip: "   ", name: "Atlantic Oceanside" },
      SOURCE,
      NOW
    );
    expect(rows.map((r) => r.fieldName)).toEqual(["name"]);
  });

  it("is the difference between requiring EVIDENCE and requiring a ROW", () => {
    // Attributing "we believe the close time is nothing" to a source states
    // something the source never said, and would let a row pass a
    // has-provenance check while carrying none — the exact degradation the
    // OPE-433 thread warned about.
    expect(isCiteableValue("")).toBe(false);
    expect(isCiteableValue(null)).toBe(false);
    expect(isCiteableValue(undefined)).toBe(false);
    expect(isCiteableValue(NaN)).toBe(false);
  });

  it("keeps a legitimate zero", () => {
    // A latitude of 0 is absurd for New England but the rule must not be
    // "falsy is absent" — that class of bug is how real values disappear.
    expect(isCiteableValue(0)).toBe(true);
    expect(isCiteableValue(false)).toBe(true);
  });
});

describe("the allow-list", () => {
  it("ignores fields a source cannot meaningfully be wrong about", () => {
    const rows = buildEntityCitations(
      "VENUE",
      "v1",
      { name: "X", updated_at: "2026-08-18", view_count: 12, internal_note: "hi" },
      SOURCE,
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldName).toBe("name");
  });

  it("keeps the two entities' lists separate", () => {
    // A venue has no open_time; a day has no zip. Sharing one list would let a
    // caller cite a field the entity does not have.
    expect(CITABLE_FIELDS.VENUE.has("open_time")).toBe(false);
    expect(CITABLE_FIELDS.EVENT_DAY.has("zip")).toBe(false);
    expect(CITABLE_FIELDS.VENUE.has("address")).toBe(true);
    expect(CITABLE_FIELDS.EVENT_DAY.has("open_time")).toBe(true);
  });

  it("drops an EVENT_DAY field sent against a VENUE", () => {
    expect(buildEntityCitations("VENUE", "v1", { open_time: "09:00" }, SOURCE, NOW)).toHaveLength(
      0
    );
  });
});

describe("writing nothing is a normal outcome, not an error", () => {
  it("returns empty when there is no source URL", () => {
    // An operator fixing a typo has no source. Recording one would be a
    // fiction; recording nothing is correct.
    expect(
      buildEntityCitations("VENUE", "v1", { name: "X" }, { ...SOURCE, sourceUrl: "" }, NOW)
    ).toEqual([]);
  });

  it("returns empty when there is no entity id", () => {
    expect(buildEntityCitations("VENUE", "", { name: "X" }, SOURCE, NOW)).toEqual([]);
  });

  it("returns empty for a patch with nothing citeable in it", () => {
    expect(buildEntityCitations("VENUE", "v1", { capacity: 200 }, SOURCE, NOW)).toEqual([]);
  });
});

describe("toCitationFields", () => {
  it("maps camelCase to the stored names and drops the rest", () => {
    expect(toCitationFields({ openTime: "9", closeTime: "5", capacity: 10, foo: 1 })).toEqual({
      open_time: "9",
      close_time: "5",
    });
  });

  it("passes through names that are already snake_case", () => {
    expect(toCitationFields({ open_time: "9" })).toEqual({ open_time: "9" });
  });
});

describe("carried metadata", () => {
  it("keeps the source identity and actor on every row", () => {
    const rows = buildEntityCitations(
      "VENUE",
      "v1",
      { name: "X", city: "Bar Harbor" },
      { ...SOURCE, confidence: 0.9, createdBy: "venues_geocode", notes: "google places" },
      NOW
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.sourceName).toBe("islandartsassociation.com");
      expect(r.confidence).toBe(0.9);
      expect(r.createdBy).toBe("venues_geocode");
      expect(r.createdAt).toEqual(NOW);
    }
  });
});

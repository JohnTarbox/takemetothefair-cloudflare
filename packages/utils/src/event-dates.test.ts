import { describe, expect, it } from "vitest";
import { normalizeEventDate } from "./event-dates";

describe("normalizeEventDate", () => {
  describe("string inputs", () => {
    it("bare YYYY-MM-DD lands at noon UTC", () => {
      const d = normalizeEventDate("2026-07-15");
      expect(d?.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    });

    it("explicit midnight UTC shifts to noon UTC", () => {
      expect(normalizeEventDate("2026-07-15T00:00:00Z")?.toISOString()).toBe(
        "2026-07-15T12:00:00.000Z"
      );
      expect(normalizeEventDate("2026-07-15T00:00:00.000Z")?.toISOString()).toBe(
        "2026-07-15T12:00:00.000Z"
      );
    });

    it("OPE-1011: LOCAL midnight with an offset anchors its own calendar date at noon UTC", () => {
      // The oxford-fair shape: midnight EDT, stored as 04:00Z before this.
      expect(normalizeEventDate("2026-09-16T00:00:00-04:00")?.toISOString()).toBe(
        "2026-09-16T12:00:00.000Z"
      );
      // The winter case that actually renders a day early under an Eastern render.
      expect(normalizeEventDate("2026-11-15T00:00:00-05:00")?.toISOString()).toBe(
        "2026-11-15T12:00:00.000Z"
      );
      expect(normalizeEventDate("2026-11-15T00:00-0500")?.toISOString()).toBe(
        "2026-11-15T12:00:00.000Z"
      );
    });

    it("OPE-1011: a real local clock time with an offset is NOT treated as date-only", () => {
      expect(normalizeEventDate("2026-09-16T09:00:00-04:00")?.toISOString()).toBe(
        "2026-09-16T13:00:00.000Z"
      );
    });

    it("non-midnight ISO passes through unchanged", () => {
      expect(normalizeEventDate("2026-07-15T17:30:00Z")?.toISOString()).toBe(
        "2026-07-15T17:30:00.000Z"
      );
    });

    it("returns null for empty / whitespace / nullish inputs", () => {
      expect(normalizeEventDate(null)).toBeNull();
      expect(normalizeEventDate(undefined)).toBeNull();
      expect(normalizeEventDate("")).toBeNull();
      expect(normalizeEventDate("   ")).toBeNull();
    });

    it("returns null for unparseable strings", () => {
      expect(normalizeEventDate("not-a-date")).toBeNull();
    });

    // OPE-1685 — the regex rewrites are an allow-list of shapes; these are
    // shapes outside it that still parse to exact midnight UTC. Each one used to
    // store as 00:00Z and render the day before on the Eastern-time site.
    it("OPE-1685: off-list ISO shapes that parse to midnight UTC anchor at noon", () => {
      for (const s of [
        "2026-11-21T00:00Z",
        "2026-11-21T00:00:00.000000Z",
        "2026-11-21T00:00:00.0Z",
      ]) {
        expect(normalizeEventDate(s)?.toISOString(), s).toBe("2026-11-21T12:00:00.000Z");
      }
    });

    it("OPE-1685: local-parsed date strings anchor at noon under the Workers zone (UTC)", () => {
      // These parse as LOCAL midnight. Workers run in UTC, which is where the
      // defect lived, so pin the zone rather than inherit the dev machine's.
      const prevTz = process.env.TZ;
      process.env.TZ = "UTC";
      try {
        expect(new Date("November 21, 2026").toISOString()).toBe("2026-11-21T00:00:00.000Z");
        for (const s of [
          "November 21, 2026",
          "Saturday, November 21, 2026",
          "Nov 21 2026",
          "11/21/2026",
          "2026/11/21",
          "2026-11-21T00:00",
          "2026-11-21 00:00:00",
        ]) {
          expect(normalizeEventDate(s)?.toISOString(), s).toBe("2026-11-21T12:00:00.000Z");
        }
      } finally {
        if (prevTz === undefined) delete process.env.TZ;
        else process.env.TZ = prevTz;
      }
    });

    it("OPE-1685: a real non-midnight UTC time is still not treated as date-only", () => {
      expect(normalizeEventDate("2026-11-21T00:00:01Z")?.toISOString()).toBe(
        "2026-11-21T00:00:01.000Z"
      );
      expect(normalizeEventDate("2026-11-21T05:00:00.000Z")?.toISOString()).toBe(
        "2026-11-21T05:00:00.000Z"
      );
    });
  });

  describe("Date inputs (A3 widening 2026-06-05)", () => {
    it("midnight-UTC Date shifts to noon UTC", () => {
      // The scraper-layer failure mode: ScrapedEvent.startDate comes
      // back as a Date already at midnight UTC because the scraper used
      // `new Date('2026-07-15')`. normalizeEventDate now fixes this in
      // place rather than requiring callers to round-trip through a
      // string.
      const midnight = new Date("2026-07-15T00:00:00.000Z");
      const out = normalizeEventDate(midnight);
      expect(out?.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    });

    it("non-midnight Date passes through unchanged (assumes real time)", () => {
      const evening = new Date("2026-07-15T22:00:00.000Z");
      expect(normalizeEventDate(evening)?.toISOString()).toBe("2026-07-15T22:00:00.000Z");
    });

    it("Invalid Date returns null", () => {
      expect(normalizeEventDate(new Date("invalid"))).toBeNull();
    });

    it("does not mutate the input Date", () => {
      const input = new Date("2026-07-15T00:00:00.000Z");
      const original = input.getTime();
      normalizeEventDate(input);
      expect(input.getTime()).toBe(original);
    });
  });
});

/**
 * Tests for the JSON-LD → ExtractedEventData mapper.
 *
 * The mapper is the gate that decides whether the inbound-email workflow's
 * submit pipeline calls Workers AI at all. False-positives here translate
 * to wrong PENDING events; false-negatives just fall through to AI. So
 * test gates and field-mapping correctness aggressively.
 */

import { describe, it, expect } from "vitest";
import { tryExtractFromJsonLd } from "../jsonld-to-event";

describe("tryExtractFromJsonLd", () => {
  describe("minimum-fields gate", () => {
    it("returns null when name is missing", () => {
      expect(
        tryExtractFromJsonLd({
          "@type": "Event",
          startDate: "2026-12-15",
          description: "A great event",
        })
      ).toBeNull();
    });

    it("returns null when startDate is missing", () => {
      expect(
        tryExtractFromJsonLd({
          "@type": "Event",
          name: "Holiday Fair",
          description: "A great event",
        })
      ).toBeNull();
    });

    it("returns null when only name + startDate present (no location, no description)", () => {
      // 2 of 4 — below the analyst-spec minimum of 3.
      expect(
        tryExtractFromJsonLd({
          "@type": "Event",
          name: "Holiday Fair",
          startDate: "2026-12-15",
        })
      ).toBeNull();
    });

    it("accepts name + startDate + description (3 of 4)", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "Annual craft market",
      });
      expect(ext).not.toBeNull();
      expect(ext?.name).toBe("Holiday Fair");
      expect(ext?.description).toBe("Annual craft market");
    });

    it("accepts name + startDate + location string (3 of 4)", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        location: "Town Hall",
      });
      expect(ext).not.toBeNull();
      expect(ext?.venueName).toBe("Town Hall");
    });
  });

  describe("date normalization", () => {
    it("strips time from ISO datetime", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15T19:00:00-05:00",
        endDate: "2026-12-15T22:00:00-05:00",
        description: "x",
      });
      expect(ext?.startDate).toBe("2026-12-15");
      expect(ext?.endDate).toBe("2026-12-15");
      expect(ext?.startTime).toBe("19:00");
      expect(ext?.endTime).toBe("22:00");
    });

    it("preserves bare YYYY-MM-DD", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
      });
      expect(ext?.startDate).toBe("2026-12-15");
      expect(ext?.startTime).toBeNull();
    });

    it("falls back to Date parsing for non-ISO strings (UTC interpretation)", () => {
      // "December 15, 2026" parses as midnight in local TZ; we force UTC
      // emission to avoid off-by-one. The actual value depends on Date's
      // tolerance of this format — Node's Date does accept it.
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "December 15, 2026",
        description: "x",
      });
      expect(ext?.startDate).toBe("2026-12-15");
    });
  });

  describe("location parsing", () => {
    it("handles Place object with PostalAddress", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        location: {
          "@type": "Place",
          name: "Starling Hall",
          address: {
            "@type": "PostalAddress",
            streetAddress: "5 Main St",
            addressLocality: "Marlboro",
            addressRegion: "MA",
            postalCode: "01752",
          },
        },
      });
      expect(ext?.venueName).toBe("Starling Hall");
      expect(ext?.venueAddress).toBe("5 Main St");
      expect(ext?.venueCity).toBe("Marlboro");
      expect(ext?.venueState).toBe("MA");
      expect(ext?.stateCode).toBe("MA");
    });

    it("handles Place object with string address", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        location: {
          "@type": "Place",
          name: "Town Hall",
          address: "100 Main St, Marlboro, MA",
        },
      });
      expect(ext?.venueName).toBe("Town Hall");
      expect(ext?.venueAddress).toBe("100 Main St, Marlboro, MA");
      expect(ext?.venueCity).toBeNull();
      expect(ext?.venueState).toBeNull();
    });

    it("rejects non-2-letter addressRegion (does not transliterate full names)", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        location: {
          "@type": "Place",
          name: "Town Hall",
          address: {
            addressRegion: "Massachusetts",
          },
        },
      });
      expect(ext?.venueState).toBeNull();
    });
  });

  describe("offers / ticket fields", () => {
    it("does NOT default ticketUrl to source URL when offers.url missing", () => {
      // Analyst's A-note: ticket_url must NOT default to source_url in the
      // JSON-LD path. This test guards against regressing to the AI path's
      // ticket-url default behavior.
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
      });
      expect(ext?.ticketUrl).toBeNull();
    });

    it("extracts offers.price as a number", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
        offers: { price: 10, priceCurrency: "USD" },
      });
      expect(ext?.ticketPriceMin).toBe(10);
    });

    it("coerces offers.price from string '10.00'", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
        offers: { price: "10.00" },
      });
      expect(ext?.ticketPriceMin).toBe(10);
    });

    it("picks first offer when offers is an array", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
        offers: [
          { price: 10, url: "https://example.com/tickets/general" },
          { price: 25, url: "https://example.com/tickets/vip" },
        ],
      });
      expect(ext?.ticketPriceMin).toBe(10);
      expect(ext?.ticketUrl).toBe("https://example.com/tickets/general");
    });
  });

  describe("image parsing", () => {
    it("handles image as string", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
        image: "https://example.com/poster.jpg",
      });
      expect(ext?.imageUrl).toBe("https://example.com/poster.jpg");
    });

    it("picks first image when image is an array", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
        image: ["https://example.com/poster.jpg", "https://example.com/poster2.jpg"],
      });
      expect(ext?.imageUrl).toBe("https://example.com/poster.jpg");
    });

    it("handles image as ImageObject with url/contentUrl", () => {
      const ext = tryExtractFromJsonLd({
        "@type": "Event",
        name: "Holiday Fair",
        startDate: "2026-12-15",
        description: "x",
        image: { "@type": "ImageObject", contentUrl: "https://example.com/poster.jpg" },
      });
      expect(ext?.imageUrl).toBe("https://example.com/poster.jpg");
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  computeVendorCompletenessScore,
  computeEventCompletenessScore,
  SITEMAP_MIN_COMPLETENESS,
  type VendorScoreInput,
  type EventScoreInput,
} from "./index";

const FULL_VENDOR: VendorScoreInput = {
  description: "Hand-crafted goods, made locally with care.",
  logoUrl: "https://example.com/logo.png",
  contactPhone: "555-555-5555",
  contactEmail: "v@example.com",
  website: "https://example.com",
  vendorType: "Crafts",
  products: '["Mugs","Plates"]',
  claimed: true,
};

const EMPTY_VENDOR: VendorScoreInput = {
  description: null,
  logoUrl: null,
  contactPhone: null,
  contactEmail: null,
  website: null,
  vendorType: null,
  products: "[]",
  claimed: false,
};

const FULL_EVENT: EventScoreInput = {
  description: "A multi-day fair with crafts and food.",
  startDate: new Date("2026-06-01"),
  endDate: new Date("2026-06-03"),
  venueId: "v-1",
  isStatewide: false,
  categories: '["Fair","Festival"]',
  imageUrl: "https://cdn.example.com/img.jpg",
  ticketPriceMinCents: 1500,
  ticketPriceMaxCents: 2500,
};

const EMPTY_EVENT: EventScoreInput = {
  description: null,
  startDate: null,
  endDate: null,
  venueId: null,
  isStatewide: null,
  categories: "[]",
  imageUrl: null,
  ticketPriceMinCents: null,
  ticketPriceMaxCents: null,
};

describe("computeVendorCompletenessScore (§10.2)", () => {
  it("scores 100 for a fully-populated vendor", () => {
    expect(computeVendorCompletenessScore(FULL_VENDOR)).toBe(100);
  });

  it("scores 0 for an empty vendor", () => {
    expect(computeVendorCompletenessScore(EMPTY_VENDOR)).toBe(0);
  });

  it("treats whitespace-only strings as empty", () => {
    const v = { ...FULL_VENDOR, description: "   " };
    expect(computeVendorCompletenessScore(v)).toBe(70);
  });

  it("treats '[]' products as empty", () => {
    const v = { ...FULL_VENDOR, products: "[]" };
    expect(computeVendorCompletenessScore(v)).toBe(90);
  });

  it("treats malformed JSON products as empty (does not throw)", () => {
    const v = { ...FULL_VENDOR, products: "not-json" };
    expect(computeVendorCompletenessScore(v)).toBe(90);
  });

  it("phone OR email satisfies the contact bucket (10pts only once)", () => {
    const phoneOnly = { ...EMPTY_VENDOR, contactPhone: "555" };
    const emailOnly = { ...EMPTY_VENDOR, contactEmail: "x@y.com" };
    const both = { ...EMPTY_VENDOR, contactPhone: "555", contactEmail: "x@y.com" };
    expect(computeVendorCompletenessScore(phoneOnly)).toBe(10);
    expect(computeVendorCompletenessScore(emailOnly)).toBe(10);
    expect(computeVendorCompletenessScore(both)).toBe(10);
  });

  it("each component matches its rubric weight", () => {
    expect(computeVendorCompletenessScore({ ...EMPTY_VENDOR, description: "x" })).toBe(30);
    expect(computeVendorCompletenessScore({ ...EMPTY_VENDOR, logoUrl: "x" })).toBe(15);
    expect(computeVendorCompletenessScore({ ...EMPTY_VENDOR, website: "x" })).toBe(10);
    expect(computeVendorCompletenessScore({ ...EMPTY_VENDOR, vendorType: "x" })).toBe(15);
    expect(computeVendorCompletenessScore({ ...EMPTY_VENDOR, products: '["a"]' })).toBe(10);
    expect(computeVendorCompletenessScore({ ...EMPTY_VENDOR, claimed: true })).toBe(10);
  });
});

describe("computeEventCompletenessScore (§10.2)", () => {
  it("scores 100 for a fully-populated event", () => {
    expect(computeEventCompletenessScore(FULL_EVENT)).toBe(100);
  });

  it("scores 0 for an empty event", () => {
    expect(computeEventCompletenessScore(EMPTY_EVENT)).toBe(0);
  });

  it("requires BOTH startDate and endDate for the date bucket", () => {
    expect(computeEventCompletenessScore({ ...EMPTY_EVENT, startDate: new Date() })).toBe(0);
    expect(
      computeEventCompletenessScore({
        ...EMPTY_EVENT,
        startDate: new Date(),
        endDate: new Date(),
      })
    ).toBe(20);
  });

  it("venueId OR isStatewide satisfies the venue bucket", () => {
    expect(computeEventCompletenessScore({ ...EMPTY_EVENT, isStatewide: true })).toBe(15);
    expect(computeEventCompletenessScore({ ...EMPTY_EVENT, venueId: "v-1" })).toBe(15);
  });

  it("price min OR max satisfies the price bucket", () => {
    expect(computeEventCompletenessScore({ ...EMPTY_EVENT, ticketPriceMinCents: 100 })).toBe(10);
    expect(computeEventCompletenessScore({ ...EMPTY_EVENT, ticketPriceMaxCents: 100 })).toBe(10);
  });
});

describe("SITEMAP_MIN_COMPLETENESS", () => {
  it("is 40 (matches the §10.2 spec gate)", () => {
    expect(SITEMAP_MIN_COMPLETENESS).toBe(40);
  });
});

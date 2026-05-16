import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  nameMatchesAdminFlag,
  dateLooksImplausible,
  sourceCredibilityTier,
  evaluateGates,
} from "../event-date-gates";

// Pre-ingest gates are the single line of defense against the failure modes
// the analyst's 2026-05-16 audit caught. Tests pin the analyst's enumerated
// patterns — adding a new pattern to event-date-gates.ts without updating
// these tests should be a CI warning, not a silent regression.

// ---------------------------------------------------------------------------
// nameMatchesAdminFlag
// ---------------------------------------------------------------------------

describe("nameMatchesAdminFlag", () => {
  it("flags 'CALL FOR ARTISTS' (analyst case 1)", () => {
    const r = nameMatchesAdminFlag("CALL FOR ARTISTS — Concord Fest");
    expect(r.matched).toBe(true);
    expect(r.reasons).toContain("name_call_for_pattern");
  });

  it("flags 'Vendor REGISTRATION Open' (analyst case 2)", () => {
    const r = nameMatchesAdminFlag("Vendor REGISTRATION Open");
    expect(r.matched).toBe(true);
    expect(r.reasons).toContain("name_registration_pattern");
  });

  it("flags em-dash sub-venue suffix (analyst case 3)", () => {
    const r = nameMatchesAdminFlag("Concord Arts Festival — Arts Alley");
    expect(r.matched).toBe(true);
    expect(r.reasons).toContain("name_em_dash_subvenue");
  });

  it("does NOT flag normal names with hyphens or en-dashes", () => {
    // Hyphens (rock-n-roll) and en-dashes (May 1–5) appear in normal names
    // and must not trigger the em-dash subvenue check.
    expect(nameMatchesAdminFlag("Rock-N-Roll Fair").matched).toBe(false);
    expect(nameMatchesAdminFlag("May 1–5 Festival").matched).toBe(false);
  });

  it("decodes HTML entities before matching", () => {
    // Memory feedback_mcp_input_decode.md — name may arrive as
    // "Call for &amp; vendors" or with numeric em-dash entity.
    const r = nameMatchesAdminFlag("Concord Arts Festival &#8212; Arts Alley");
    expect(r.matched).toBe(true);
    expect(r.reasons).toContain("name_em_dash_subvenue");
  });

  it("handles null + empty name without throwing", () => {
    expect(nameMatchesAdminFlag(null).matched).toBe(false);
    expect(nameMatchesAdminFlag(undefined).matched).toBe(false);
    expect(nameMatchesAdminFlag("").matched).toBe(false);
  });

  it("returns multiple reasons when multiple patterns match", () => {
    const r = nameMatchesAdminFlag("Call for Vendor Registration");
    expect(r.matched).toBe(true);
    expect(r.reasons).toContain("name_call_for_pattern");
    expect(r.reasons).toContain("name_registration_pattern");
  });

  it("does NOT flag 'apply' inside longer words like 'application'", () => {
    // Tests the \b word boundary in the apply pattern.
    expect(nameMatchesAdminFlag("Vendor Applications Now Open").reasons).not.toContain(
      "name_apply_pattern"
    );
    // But standalone "apply" still matches.
    expect(nameMatchesAdminFlag("Apply Today: Maker Faire").reasons).toContain(
      "name_apply_pattern"
    );
  });
});

// ---------------------------------------------------------------------------
// dateLooksImplausible
// ---------------------------------------------------------------------------

describe("dateLooksImplausible", () => {
  beforeAll(() => {
    // Pin "now" for deterministic tests. Pick a date safely within the
    // current 2026 working window so the 18-month boundary calculations
    // don't drift over test runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("flags start_date == application_deadline (analyst case 4 / NH Maker Fest)", () => {
    const sameDay = new Date("2026-06-15");
    const r = dateLooksImplausible({
      startDate: sameDay,
      endDate: new Date("2026-06-16"),
      applicationDeadline: sameDay,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("start_equals_deadline");
  });

  it("flags single-day storage of a 'Friday through Sunday' multi-day event (analyst case 5)", () => {
    const day = new Date("2026-07-10");
    const r = dateLooksImplausible({
      startDate: day,
      endDate: day,
      description: "Join us Friday through Sunday for a weekend of family fun.",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("start_equals_end_but_description_multi_day");
  });

  it("flags single-day storage when description mentions '2-day'", () => {
    const day = new Date("2026-07-10");
    const r = dateLooksImplausible({
      startDate: day,
      endDate: day,
      description: "A 2-day craft festival in downtown Concord.",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("start_equals_end_but_description_multi_day");
  });

  it("does NOT flag legitimate single-day events", () => {
    const day = new Date("2026-07-10");
    const r = dateLooksImplausible({
      startDate: day,
      endDate: day,
      description: "A one-day farmers market in downtown Concord.",
    });
    expect(r.ok).toBe(true);
  });

  it("flags start_date more than 18 months in the future (analyst case 6)", () => {
    const r = dateLooksImplausible({
      startDate: new Date("2028-12-01"), // ~30 months out from 2026-05-16
      endDate: new Date("2028-12-02"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("start_too_far_future");
  });

  it("flags end_date in the past (Cape Cod Chamber stale-prior-year mode)", () => {
    const r = dateLooksImplausible({
      startDate: new Date("2025-05-19"),
      endDate: new Date("2025-05-19"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("end_date_in_past");
  });

  it("returns ok for plausible future single-day event", () => {
    const r = dateLooksImplausible({
      startDate: new Date("2026-08-15"),
      endDate: new Date("2026-08-15"),
      description: "A one-day farmers market.",
    });
    expect(r.ok).toBe(true);
  });

  it("handles missing dates without throwing", () => {
    expect(dateLooksImplausible({ startDate: null, endDate: null }).ok).toBe(true);
    expect(dateLooksImplausible({ startDate: undefined, endDate: undefined }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sourceCredibilityTier
// ---------------------------------------------------------------------------

describe("sourceCredibilityTier", () => {
  it("classifies confirmed-Tier-3 DMO/aggregator hostnames as Tier 3 (analyst 2026-05-16)", () => {
    expect(sourceCredibilityTier("https://lakesregion.org/events/123")).toBe(3);
    expect(sourceCredibilityTier("capecodchamber.org")).toBe(3);
    expect(sourceCredibilityTier("https://berkshires.org/events/foo")).toBe(3);
    expect(sourceCredibilityTier("https://visitwhitemountains.com/listing")).toBe(3);
    expect(sourceCredibilityTier("mainemade.com")).toBe(3);
    expect(sourceCredibilityTier("https://www.visitfreeport.com/events")).toBe(3);
  });

  it("classifies Tier-2 DMO allowlist as Tier 2 (analyst 2026-05-16)", () => {
    // Tier 2 = clean data historically; gates still apply but auto-approve
    // on pass. mainetourism.com is in this list with a caveat — re-eval if
    // PENDING_REVIEW rate >30% after a month.
    expect(sourceCredibilityTier("https://www.mainetourism.com/listing")).toBe(2);
    expect(sourceCredibilityTier("visitrhodeisland.com")).toBe(2);
    expect(sourceCredibilityTier("https://visitvermont.com/events")).toBe(2);
    expect(sourceCredibilityTier("ctvisit.com")).toBe(2);
    expect(sourceCredibilityTier("https://www.visitnh.gov/things-to-do")).toBe(2);
  });

  it("classifies TEC-API marker as Tier 3 regardless of host", () => {
    expect(sourceCredibilityTier("tec-api://some-feed")).toBe(3);
    expect(sourceCredibilityTier("https://example.com/tec-api/v1/events")).toBe(3);
  });

  it("classifies named scrapers as Tier 2", () => {
    expect(sourceCredibilityTier("mainefairs.net")).toBe(2);
    expect(sourceCredibilityTier("mainefairs")).toBe(2);
    expect(sourceCredibilityTier("fairgrounds-scraper")).toBe(2);
  });

  it("classifies unknown sources as Tier 1 (direct input / trusted default)", () => {
    expect(sourceCredibilityTier("admin-direct")).toBe(1);
    expect(sourceCredibilityTier("https://example-promoter.com")).toBe(1);
    expect(sourceCredibilityTier(null)).toBe(1);
    expect(sourceCredibilityTier(undefined)).toBe(1);
    expect(sourceCredibilityTier("")).toBe(1);
  });

  it("strips www. before lookup so www-prefixed Tier 3 hosts still match", () => {
    expect(sourceCredibilityTier("https://www.lakesregion.org/event")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// evaluateGates — the unified evaluator every ingest path calls
// ---------------------------------------------------------------------------

describe("evaluateGates", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("Tier 3 source ALWAYS routes to PENDING_REVIEW even with clean data", () => {
    const r = evaluateGates({
      name: "Berkshires Spring Fair",
      sourceUrl: "https://berkshires.org/events/spring-fair",
      startDate: new Date("2026-06-15"),
      endDate: new Date("2026-06-17"),
    });
    expect(r.route).toBe("PENDING_REVIEW");
    expect(r.tier).toBe(3);
    expect(r.reasons).toContain("source_tier_3_aggregator");
  });

  it("Tier 1 + clean data routes to APPROVED (no gates fire)", () => {
    const r = evaluateGates({
      name: "Concord Annual Maker Faire",
      sourceName: "admin-direct",
      startDate: new Date("2026-08-15"),
      endDate: new Date("2026-08-17"),
      description: "A 3-day celebration of craft and innovation.",
    });
    expect(r.route).toBe("APPROVED");
    expect(r.tier).toBe(1);
    expect(r.reasons).toEqual([]);
  });

  it("Tier 1 + bad name routes to PENDING_REVIEW", () => {
    const r = evaluateGates({
      name: "Call for Vendors: Spring Fair",
      sourceName: "admin-direct",
      startDate: new Date("2026-08-15"),
      endDate: new Date("2026-08-17"),
    });
    expect(r.route).toBe("PENDING_REVIEW");
    expect(r.reasons).toContain("name_call_for_pattern");
  });

  it("Tier 2 + start==deadline routes to PENDING_REVIEW (NH Maker Fest mode)", () => {
    const sameDay = new Date("2026-06-15");
    const r = evaluateGates({
      name: "NH Maker Fest",
      sourceName: "mainefairs.net",
      startDate: sameDay,
      endDate: sameDay,
      applicationDeadline: sameDay,
    });
    expect(r.route).toBe("PENDING_REVIEW");
    expect(r.tier).toBe(2);
    expect(r.reasons).toContain("start_equals_deadline");
  });

  it("returns ALL firing reasons, not just the first", () => {
    const sameDay = new Date("2026-06-15");
    const r = evaluateGates({
      name: "Call for Artists — Berkshires Fair",
      sourceUrl: "https://berkshires.org/events/123",
      startDate: sameDay,
      endDate: sameDay,
      applicationDeadline: sameDay,
      description: "A weekend of art and craft.",
    });
    expect(r.route).toBe("PENDING_REVIEW");
    expect(r.reasons).toContain("source_tier_3_aggregator");
    expect(r.reasons).toContain("name_call_for_pattern");
    expect(r.reasons).toContain("name_em_dash_subvenue");
    expect(r.reasons).toContain("start_equals_deadline");
    expect(r.reasons).toContain("start_equals_end_but_description_multi_day");
  });
});

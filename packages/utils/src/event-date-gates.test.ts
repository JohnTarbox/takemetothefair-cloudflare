import { describe, it, expect } from "vitest";
import { evaluateGates, nameMatchesAdminFlag, sourceCredibilityTier } from "./event-date-gates";

describe("nameMatchesAdminFlag — analyst spec 2026-05-22", () => {
  it("flags 'CALL FOR' wording", () => {
    expect(nameMatchesAdminFlag("Maker Fest — Call for Artists").reasons).toContain(
      "name_call_for_pattern"
    );
    expect(nameMatchesAdminFlag("CALL FOR VENDORS — Spring Show").reasons).toContain(
      "name_call_for_pattern"
    );
  });

  it("flags 'REGISTRATION' wording", () => {
    expect(nameMatchesAdminFlag("Vendor Registration Now Open").reasons).toContain(
      "name_registration_pattern"
    );
  });

  it("flags 'REGISTER' wording on its own (broadened 2026-05-22)", () => {
    // The old /\bregistration\b/ regex missed this case; the new
    // /\bregist(?:er|ration)s?\b/ catches both forms.
    expect(nameMatchesAdminFlag("REGISTER NOW — Fall Craft Show").reasons).toContain(
      "name_registration_pattern"
    );
    expect(nameMatchesAdminFlag("Register for the 2026 Maker Fest").reasons).toContain(
      "name_registration_pattern"
    );
  });

  it("flags 'APPLY' wording", () => {
    expect(nameMatchesAdminFlag("Apply Today — Holiday Bazaar").reasons).toContain(
      "name_apply_pattern"
    );
  });

  it("flags 'APPLICATION'/'APPLICATIONS' wording (broadened 2026-05-22)", () => {
    // The old /\bapply\b/ regex did NOT match "application" — \b fails
    // between 'y' and 'i'. The new alternation catches both forms.
    expect(nameMatchesAdminFlag("Vendor Application Open").reasons).toContain("name_apply_pattern");
    expect(nameMatchesAdminFlag("VENDOR APPLICATIONS OPEN").reasons).toContain(
      "name_apply_pattern"
    );
  });

  it("does NOT flag legitimate event names that share root letters", () => {
    // "application" should fire; longer real words containing it should
    // also fire (that's fine — these are review-only, false positives are
    // acceptable in PENDING_REVIEW). Sanity-check that names without any
    // of the triggers pass through clean.
    expect(nameMatchesAdminFlag("Cumberland Fair").reasons).toEqual([]);
    expect(nameMatchesAdminFlag("Bristol 4th of July Parade").reasons).toEqual([]);
    expect(nameMatchesAdminFlag("Fryeburg Fair 2026").reasons).toEqual([]);
  });
});

describe("sourceCredibilityTier — analyst spec 2026-05-22", () => {
  it("returns Tier 1 for null/empty source (direct human input)", () => {
    expect(sourceCredibilityTier(null)).toBe(1);
    expect(sourceCredibilityTier(undefined)).toBe(1);
    expect(sourceCredibilityTier("")).toBe(1);
  });

  it("returns Tier 2 for known scraper sources", () => {
    expect(sourceCredibilityTier("mainefairs.net")).toBe(2);
    expect(sourceCredibilityTier("https://mainetourism.com/events/123")).toBe(2);
  });

  it("returns Tier 3 for known aggregator hosts and TEC-API marker", () => {
    expect(sourceCredibilityTier("capecodchamber.org")).toBe(3);
    expect(sourceCredibilityTier("https://berkshires.org/events")).toBe(3);
    expect(sourceCredibilityTier("tec-api://internal-feed")).toBe(3);
  });
});

describe("evaluateGates — Tier-3 always routes to PENDING_REVIEW", () => {
  it("routes Tier-3 sources to PENDING even with clean names and plausible dates", () => {
    const future = new Date();
    future.setMonth(future.getMonth() + 3);
    const result = evaluateGates({
      name: "Cape Cod Craft Festival",
      sourceUrl: "https://capecodchamber.org/event/123",
      startDate: future,
      endDate: future,
    });
    expect(result.route).toBe("PENDING_REVIEW");
    expect(result.reasons).toContain("source_tier_3_aggregator");
    expect(result.tier).toBe(3);
  });
});

describe("evaluateGates — date-plausibility checks (analyst spec)", () => {
  it("flags start_date == application_deadline", () => {
    const d = new Date("2026-09-01T12:00:00Z");
    const result = evaluateGates({
      name: "Fall Maker Fest",
      sourceName: "mainefairs.net",
      startDate: d,
      endDate: d,
      applicationDeadline: d,
    });
    expect(result.reasons).toContain("start_equals_deadline");
  });

  it("flags start_date == end_date with multi-day description language", () => {
    const d = new Date("2026-07-15T12:00:00Z");
    const result = evaluateGates({
      name: "Northeast Coffee Festival",
      sourceName: "mainefairs.net",
      startDate: d,
      endDate: d,
      description: "Join us for this three-day festival Friday through Sunday!",
    });
    expect(result.reasons).toContain("start_equals_end_but_description_multi_day");
  });

  it("flags past end_date", () => {
    const past = new Date("2024-01-01T12:00:00Z");
    const result = evaluateGates({
      name: "Old Festival",
      sourceName: "mainefairs.net",
      startDate: past,
      endDate: past,
    });
    expect(result.reasons).toContain("end_date_in_past");
  });

  it("flags a past single-day auto-create with no end date (OPE-201 poster case)", () => {
    const past = new Date("2024-08-23T12:00:00Z");
    const result = evaluateGates({
      name: "Washington County Fair 2024",
      sourceName: "mainefairs.net",
      startDate: past,
      endDate: null,
    });
    expect(result.reasons).toContain("start_date_in_past");
    expect(result.route).toBe("PENDING_REVIEW");
  });

  it("does NOT flag an in-progress event (start past, end future) as start_date_in_past", () => {
    const start = new Date(Date.now() - 2 * 86400000); // 2 days ago
    const end = new Date(Date.now() + 2 * 86400000); // 2 days out
    const result = evaluateGates({
      name: "Big State Fair",
      sourceName: "mainefairs.net",
      startDate: start,
      endDate: end,
      eventScale: "MAJOR",
    });
    expect(result.reasons).not.toContain("start_date_in_past");
  });
});

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

/**
 * OPE-307 — the assumption migration 0173 rests on.
 *
 * The cleanup closes `start_date_timezone_confused` rows whose event is now
 * noon-UTC anchored, on the grounds that the detector short-circuits there and
 * would never re-file them. If that ever stopped being true, the cleanup would
 * be closing live findings and they would silently re-open the next night.
 *
 * Pinning both sides: noon is clean, midnight-Eastern is not.
 */
describe("evaluateGates — timezone anchoring (OPE-307)", () => {
  const base = {
    name: "Test Fair",
    description: null,
    sourceUrl: "https://organizer.example/fair",
  };

  it("noon UTC is clean — the anchor normalizeEventDate produces", () => {
    const result = evaluateGates({
      ...base,
      startDate: new Date("2026-09-01T12:00:00Z"),
      endDate: new Date("2026-09-03T12:00:00Z"),
    });
    expect(result.reasons).not.toContain("start_date_timezone_confused");
  });

  it("midnight UTC still flags — the original symptom", () => {
    const result = evaluateGates({
      ...base,
      startDate: new Date("2026-09-01T00:00:00Z"),
      endDate: new Date("2026-09-03T00:00:00Z"),
    });
    expect(result.reasons).toContain("start_date_timezone_confused");
  });
});

describe("sameDay compares calendar days, not a millisecond delta (OPE-526)", () => {
  /**
   * The regression this pins.
   *
   * `sameDay` used `Math.abs(a - b) < 12h`. The codebase's two date-only
   * parsers sit EXACTLY 12h apart — normalizeEventDate anchors at 12:00Z,
   * parseDateOnly at 00:00Z — and `12h < 12h` is false. So any gate comparing
   * a noon-anchored date against a midnight-anchored one returned false for
   * EVERY date, not just timezone edge cases.
   *
   * Live consequence: start_equals_deadline was wired on the URL-import path
   * by OPE-198, but import-url builds startDate with normalizeEventDate when
   * the extractor produced no event-days (route.ts:162) — so on that branch
   * the gate could never fire, while reading as shipped.
   */
  const NOON = new Date("2026-09-15T12:00:00.000Z"); // normalizeEventDate
  const MIDNIGHT = new Date("2026-09-15T00:00:00.000Z"); // parseDateOnly

  it("the two parsers really are exactly 12h apart — the premise of this test", () => {
    expect(NOON.getTime() - MIDNIGHT.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it("fires start_equals_deadline across the noon/midnight boundary", () => {
    const result = evaluateGates({
      name: "Deadline Equals Start Fair",
      sourceUrl: "https://example.org/fair",
      sourceName: "url-import",
      startDate: NOON,
      endDate: NOON,
      applicationDeadline: MIDNIGHT,
      description: null,
    });
    expect(result.reasons).toContain("start_equals_deadline");
  });

  it("still does not fire on genuinely different days (control)", () => {
    const result = evaluateGates({
      name: "Normal Fair",
      sourceUrl: "https://example.org/fair",
      sourceName: "url-import",
      startDate: NOON,
      endDate: NOON,
      applicationDeadline: new Date("2026-08-01T00:00:00.000Z"),
      description: null,
    });
    expect(result.reasons).not.toContain("start_equals_deadline");
  });

  it("does not fire across an adjacent-day boundary 1ms apart", () => {
    // The old 12h window would have called these the same day. They are not.
    const result = evaluateGates({
      name: "Adjacent Fair",
      sourceUrl: "https://example.org/fair",
      sourceName: "url-import",
      startDate: new Date("2026-09-15T23:59:59.999Z"),
      endDate: new Date("2026-09-15T23:59:59.999Z"),
      applicationDeadline: new Date("2026-09-16T00:00:00.000Z"),
      description: null,
    });
    expect(result.reasons).not.toContain("start_equals_deadline");
  });
});

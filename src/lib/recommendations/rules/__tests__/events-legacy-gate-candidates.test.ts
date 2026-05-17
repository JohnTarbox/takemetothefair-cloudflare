import { describe, it, expect, vi, beforeEach } from "vitest";
import { eventsLegacyGateCandidatesRule } from "../events-legacy-gate-candidates";

// Mock drizzle chain: select().from().where() → resolves to rows.
// The rule then replays evaluateGates() over the rows in JS.

let mockRows: unknown[] = [];
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn(async () => mockRows.slice()),
};
type RuleDb = Parameters<typeof eventsLegacyGateCandidatesRule.run>[0];

beforeEach(() => {
  mockRows = [];
  vi.clearAllMocks();
});

describe("eventsLegacyGateCandidatesRule.run", () => {
  it("returns no items when no APPROVED rows exist", async () => {
    const items = await eventsLegacyGateCandidatesRule.run(mockDb as unknown as RuleDb);
    expect(items).toEqual([]);
  });

  it("flags an APPROVED row from a Tier 3 source", async () => {
    mockRows = [
      {
        id: "evt-tier3",
        name: "Some Festival",
        slug: "some-festival",
        sourceUrl: "https://capecodchamber.org/events/x",
        sourceName: null,
        startDate: new Date("2027-01-01T00:00:00Z"),
        endDate: new Date("2027-01-01T00:00:00Z"),
        applicationDeadline: null,
        description: null,
      },
    ];
    const items = await eventsLegacyGateCandidatesRule.run(mockDb as unknown as RuleDb);
    expect(items).toHaveLength(1);
    expect(items[0].targetId).toBe("evt-tier3");
    expect(items[0].payload?.would_flag_reasons).toContain("source_tier_3_aggregator");
    expect(items[0].payload?.source_tier).toBe(3);
  });

  it("does NOT flag an APPROVED row with a Tier 1 source and clean dates / name", async () => {
    mockRows = [
      {
        id: "evt-clean",
        name: "Annual Fair",
        slug: "annual-fair",
        sourceUrl: null, // no source = Tier 1
        sourceName: null,
        startDate: new Date("2027-07-01T00:00:00Z"),
        endDate: new Date("2027-07-03T00:00:00Z"),
        applicationDeadline: null,
        description: "Three days of fun for the whole family.",
      },
    ];
    const items = await eventsLegacyGateCandidatesRule.run(mockDb as unknown as RuleDb);
    expect(items).toEqual([]);
  });

  it("flags a Tier 2 row whose name contains 'CALL FOR' (NH Maker Fest scenario)", async () => {
    mockRows = [
      {
        id: "evt-call-for",
        name: "CALL FOR MAKERS — NH Maker Fest",
        slug: "call-for-makers-nh-maker-fest",
        sourceUrl: "https://mainetourism.com/events/x",
        sourceName: null,
        startDate: new Date("2027-06-06T00:00:00Z"),
        endDate: null,
        applicationDeadline: null,
        description: null,
      },
    ];
    const items = await eventsLegacyGateCandidatesRule.run(mockDb as unknown as RuleDb);
    expect(items).toHaveLength(1);
    expect(items[0].payload?.would_flag_reasons).toContain("name_call_for_pattern");
  });

  it("flags Gate A2 (start_equals_deadline) — only firable now that the rule loads applicationDeadline", async () => {
    // Same-day start_date and applicationDeadline on a Tier 2 source.
    // Before this rule existed, no live code path could surface this — the
    // 4 import paths all hardcode applicationDeadline=null, and admin POST
    // wasn't gated. This row was effectively unreachable to admins.
    mockRows = [
      {
        id: "evt-deadline-collision",
        name: "Test Festival",
        slug: "test-festival",
        sourceUrl: "https://visitnh.gov/events/x",
        sourceName: null,
        startDate: new Date("2027-08-01T00:00:00Z"),
        endDate: new Date("2027-08-01T00:00:00Z"),
        applicationDeadline: new Date("2027-08-01T00:00:00Z"),
        description: null,
      },
    ];
    const items = await eventsLegacyGateCandidatesRule.run(mockDb as unknown as RuleDb);
    expect(items).toHaveLength(1);
    expect(items[0].payload?.would_flag_reasons).toContain("start_equals_deadline");
  });

  it("flags multi-day-description / single-day-storage mismatch (Rhododendron Festival scenario)", async () => {
    mockRows = [
      {
        id: "evt-multi-day",
        name: "Rhododendron Festival",
        slug: "rhododendron-festival",
        sourceUrl: null, // Tier 1 — date check still runs
        sourceName: null,
        startDate: new Date("2027-05-15T00:00:00Z"),
        endDate: new Date("2027-05-15T00:00:00Z"),
        applicationDeadline: null,
        description: "A three-day rhododendron festival running over the weekend.",
      },
    ];
    const items = await eventsLegacyGateCandidatesRule.run(mockDb as unknown as RuleDb);
    expect(items).toHaveLength(1);
    expect(items[0].payload?.would_flag_reasons).toContain(
      "start_equals_end_but_description_multi_day"
    );
  });
});

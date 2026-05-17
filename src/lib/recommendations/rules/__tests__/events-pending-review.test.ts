import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseGateFlags, eventsPendingReviewRule } from "../events-pending-review";

describe("parseGateFlags", () => {
  it("returns empty array for null / undefined / empty", () => {
    expect(parseGateFlags(null)).toEqual([]);
    expect(parseGateFlags(undefined)).toEqual([]);
    expect(parseGateFlags("")).toEqual([]);
  });

  it("parses a well-formed JSON array of strings", () => {
    expect(parseGateFlags('["source_tier_3_aggregator","name_call_for_pattern"]')).toEqual([
      "source_tier_3_aggregator",
      "name_call_for_pattern",
    ]);
  });

  it("returns empty for an empty JSON array", () => {
    expect(parseGateFlags("[]")).toEqual([]);
  });

  it("filters out non-string entries", () => {
    expect(parseGateFlags('["valid_reason", 42, null, true, "another_reason"]')).toEqual([
      "valid_reason",
      "another_reason",
    ]);
  });

  it("returns [] for non-array JSON shapes", () => {
    expect(parseGateFlags('{"reason":"x"}')).toEqual([]);
    expect(parseGateFlags('"string_alone"')).toEqual([]);
    expect(parseGateFlags("42")).toEqual([]);
  });

  it("returns ['unparseable_gate_flags'] for malformed JSON rather than dropping the row", () => {
    expect(parseGateFlags("not json at all")).toEqual(["unparseable_gate_flags"]);
    expect(parseGateFlags('["unterminated')).toEqual(["unparseable_gate_flags"]);
  });
});

describe("eventsPendingReviewRule.run", () => {
  // Mock drizzle chain: select().from().where().orderBy() → resolves to rows.
  // Mirrors the pattern in src/lib/__tests__/markActedAllForTarget.test.ts.

  let mockRows: unknown[] = [];
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(async () => mockRows.slice()),
  };
  type RuleDb = Parameters<typeof eventsPendingReviewRule.run>[0];

  beforeEach(() => {
    mockRows = [];
    vi.clearAllMocks();
  });

  it("returns no items when no PENDING+gate_flags rows exist", async () => {
    const items = await eventsPendingReviewRule.run(mockDb as unknown as RuleDb);
    expect(items).toEqual([]);
  });

  it("emits one item per row with parsed reasons in the payload", async () => {
    mockRows = [
      {
        id: "evt-1",
        name: "Spring Festival",
        slug: "spring-festival",
        sourceUrl: "https://capecodchamber.org/events/x",
        sourceName: null,
        startDate: new Date("2026-06-01T00:00:00Z"),
        endDate: new Date("2026-06-01T00:00:00Z"),
        gateFlags: '["source_tier_3_aggregator"]',
      },
    ];
    const items = await eventsPendingReviewRule.run(mockDb as unknown as RuleDb);
    expect(items).toHaveLength(1);
    expect(items[0].targetType).toBe("event");
    expect(items[0].targetId).toBe("evt-1");
    expect(items[0].payload).toMatchObject({
      name: "Spring Festival",
      slug: "spring-festival",
      source_url: "https://capecodchamber.org/events/x",
      reasons: ["source_tier_3_aggregator"],
    });
    expect(items[0].payload?.stored_start_date).toBe("2026-06-01T00:00:00.000Z");
  });

  it("handles malformed gate_flags JSON via the unparseable placeholder", async () => {
    mockRows = [
      {
        id: "evt-2",
        name: "Broken Flags",
        slug: "broken-flags",
        sourceUrl: null,
        sourceName: null,
        startDate: null,
        endDate: null,
        gateFlags: "not json",
      },
    ];
    const items = await eventsPendingReviewRule.run(mockDb as unknown as RuleDb);
    expect(items).toHaveLength(1);
    expect(items[0].payload?.reasons).toEqual(["unparseable_gate_flags"]);
  });

  it("preserves the SQL-imposed ordering by trusting the returned row order", async () => {
    // The rule sorts in SQL (orderBy(asc(events.startDate))). The mock returns
    // rows in the order we set, so we just verify the rule passes through.
    mockRows = [
      {
        id: "early",
        name: "Early",
        slug: "early",
        sourceUrl: null,
        sourceName: null,
        startDate: new Date("2026-05-01T00:00:00Z"),
        endDate: null,
        gateFlags: '["x"]',
      },
      {
        id: "late",
        name: "Late",
        slug: "late",
        sourceUrl: null,
        sourceName: null,
        startDate: new Date("2026-09-01T00:00:00Z"),
        endDate: null,
        gateFlags: '["y"]',
      },
    ];
    const items = await eventsPendingReviewRule.run(mockDb as unknown as RuleDb);
    expect(items.map((i) => i.targetId)).toEqual(["early", "late"]);
  });
});

/**
 * Test for getOpenMatchCountsAsOf — drives the WoW trend chip on the
 * Recommendations tab (analyst Item 10 split, 2026-05-30).
 *
 * Uses a hand-rolled drizzle-chain mock matching the shape in
 * events-pending-review.test.ts. The query is straightforward enough
 * (single COUNT GROUP BY) that the test focuses on row aggregation
 * rather than SQL composition.
 */
import { describe, it, expect, vi } from "vitest";
import { getOpenMatchCountsAsOf } from "../engine";

interface MockRow {
  ruleId: string;
  n: number;
}

function makeDb(rows: MockRow[]) {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn(async () => rows),
  } as unknown as Parameters<typeof getOpenMatchCountsAsOf>[0];
}

describe("getOpenMatchCountsAsOf", () => {
  it("maps rule ids to numeric counts", async () => {
    const db = makeDb([
      { ruleId: "r1", n: 7 },
      { ruleId: "r2", n: 3 },
    ]);
    const result = await getOpenMatchCountsAsOf(db, new Date());
    expect(result.size).toBe(2);
    expect(result.get("r1")).toBe(7);
    expect(result.get("r2")).toBe(3);
  });

  it("returns empty map when no rules had open items at the cutoff", async () => {
    const db = makeDb([]);
    const result = await getOpenMatchCountsAsOf(db, new Date());
    expect(result.size).toBe(0);
  });

  it("coerces string counts from D1 to numbers", async () => {
    // D1's underlying SQLite returns COUNT(*) as a number when SELECTed
    // through Drizzle, but the sql<number> generic isn't a runtime guard.
    // Defensive coercion guards against drivers that surface bigint or
    // string under certain bindings.
    const db = makeDb([{ ruleId: "r1", n: "12" as unknown as number }]);
    const result = await getOpenMatchCountsAsOf(db, new Date());
    expect(result.get("r1")).toBe(12);
  });

  it("missing rule id in result map means 'zero open at cutoff' (caller default)", async () => {
    // Documents the absence-as-zero contract the analytics page relies on.
    const db = makeDb([{ ruleId: "r1", n: 1 }]);
    const result = await getOpenMatchCountsAsOf(db, new Date());
    expect(result.get("r2")).toBeUndefined();
    // Caller treats undefined as 0:
    const fallback = result.get("r2") ?? 0;
    expect(fallback).toBe(0);
  });
});

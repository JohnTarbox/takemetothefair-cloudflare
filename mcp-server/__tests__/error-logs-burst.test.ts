/**
 * Unit tests for the B1 burst-watch helper.
 *
 * The helper itself runs SQL via Drizzle against D1; we test the pure
 * predicates (threshold trip, default options) by mocking the db with
 * minimal stubs that return deterministic counts.
 */

import { describe, it, expect, vi } from "vitest";
import { getErrorLogsBurstWindow } from "../src/error-logs-burst";

// Minimal db mock — only the .select().from().where()[.groupBy()...]
// surface that the helper actually exercises. Promises resolve to the
// rows we provide.
function mockDb(opts: {
  totalCount: number;
  bySource?: Array<{ source: string | null; count: number }>;
}) {
  const calls: Array<{ kind: "total" | "bySource" }> = [];

  const totalChain = {
    where: vi.fn().mockResolvedValue([{ count: opts.totalCount }]),
  };
  const bySourceChain = {
    where: vi.fn().mockReturnValue({
      groupBy: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(opts.bySource ?? []),
        }),
      }),
    }),
  };

  return {
    db: {
      select: vi.fn().mockImplementation((selection: Record<string, unknown>) => {
        const isTotal = "count" in selection && Object.keys(selection).length === 1;
        calls.push({ kind: isTotal ? "total" : "bySource" });
        return {
          from: vi.fn().mockReturnValue(isTotal ? totalChain : bySourceChain),
        };
      }),
    },
    calls,
  };
}

describe("getErrorLogsBurstWindow", () => {
  const now = new Date("2026-06-04T12:00:00Z");
  const since = new Date("2026-06-04T11:50:00Z");

  it("returns tripped:false when count < minCount", async () => {
    const { db } = mockDb({ totalCount: 5 });
    const result = await getErrorLogsBurstWindow(db as never, {
      since,
      until: now,
      minCount: 10,
    });
    expect(result.totalErrors).toBe(5);
    expect(result.tripped).toBe(false);
    expect(result.bySource).toHaveLength(0);
  });

  it("returns tripped:true when count >= minCount", async () => {
    const { db } = mockDb({
      totalCount: 47,
      bySource: [
        { source: "app/events/page.tsx:getEvents", count: 30 },
        { source: "app/venues/[slug]/page.tsx:getVenue", count: 17 },
      ],
    });
    const result = await getErrorLogsBurstWindow(db as never, {
      since,
      until: now,
      minCount: 10,
    });
    expect(result.totalErrors).toBe(47);
    expect(result.tripped).toBe(true);
    expect(result.bySource).toHaveLength(2);
    expect(result.bySource[0].source).toBe("app/events/page.tsx:getEvents");
    expect(result.bySource[0].count).toBe(30);
  });

  it("skips the bySource query when totalErrors=0 (cheap-path)", async () => {
    const { db, calls } = mockDb({ totalCount: 0 });
    const result = await getErrorLogsBurstWindow(db as never, {
      since,
      until: now,
    });
    expect(result.totalErrors).toBe(0);
    expect(result.tripped).toBe(false);
    expect(result.bySource).toEqual([]);
    // Only the total query should have run.
    expect(calls.filter((c) => c.kind === "bySource")).toHaveLength(0);
  });

  it("respects minCount option override (UR1 vs canary thresholds)", async () => {
    const { db } = mockDb({ totalCount: 25, bySource: [{ source: "x", count: 25 }] });
    // UR1 HIGH escalation uses minCount=10.
    const r1 = await getErrorLogsBurstWindow(db as never, { since, until: now, minCount: 10 });
    expect(r1.tripped).toBe(true);
    // Canary RED uses minCount=50.
    const { db: db2 } = mockDb({ totalCount: 25, bySource: [{ source: "x", count: 25 }] });
    const r2 = await getErrorLogsBurstWindow(db2 as never, { since, until: now, minCount: 50 });
    expect(r2.tripped).toBe(false);
  });

  it("default minCount is 10 (UR1's HIGH threshold)", async () => {
    const { db } = mockDb({ totalCount: 10, bySource: [{ source: "x", count: 10 }] });
    const result = await getErrorLogsBurstWindow(db as never, { since, until: now });
    expect(result.tripped).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Drizzle chain mock. The helper does:
//   1. SELECT id FROM recommendation_items WHERE targetType=X AND targetId=Y AND actedAt IS NULL
//   2. For each row: UPDATE recommendation_items SET actedAt=now WHERE id=row.id
// Mock both chains.

const selectResults: unknown[] = [];
const updateCalls: Array<{ where: unknown; set: unknown }> = [];

const updateChain = {
  set: vi.fn(function (this: typeof updateChain, set: unknown) {
    (this as unknown as { _set: unknown })._set = set;
    return this;
  }),
  where: vi.fn(async function (this: typeof updateChain, w: unknown) {
    updateCalls.push({
      where: w,
      set: (this as unknown as { _set: unknown })._set,
    });
  }),
};

const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn(async () => selectResults.slice()),
  update: vi.fn(() => updateChain),
};

import { markActedAllForTarget } from "../recommendations/engine";
type TestDb = Parameters<typeof markActedAllForTarget>[0];

beforeEach(() => {
  selectResults.length = 0;
  updateCalls.length = 0;
  vi.clearAllMocks();
});

describe("markActedAllForTarget", () => {
  it("returns 0 and writes nothing when no open items match", async () => {
    selectResults.push(); // empty
    const n = await markActedAllForTarget(mockDb as unknown as TestDb, "vendor", "v-1");
    expect(n).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it("marks every open item acted and returns the count", async () => {
    selectResults.push({ id: "item-1" }, { id: "item-2" }, { id: "item-3" });
    const n = await markActedAllForTarget(mockDb as unknown as TestDb, "vendor", "v-1");
    expect(n).toBe(3);
    expect(updateCalls.length).toBe(3);
  });

  it("sets actedAt on each update", async () => {
    selectResults.push({ id: "item-1" });
    const before = Date.now();
    await markActedAllForTarget(mockDb as unknown as TestDb, "vendor", "v-1");
    const after = Date.now();
    expect(updateCalls.length).toBe(1);
    const setPayload = updateCalls[0].set as { actedAt: Date };
    expect(setPayload.actedAt).toBeInstanceOf(Date);
    expect(setPayload.actedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setPayload.actedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("can be called for non-vendor target types", async () => {
    selectResults.push({ id: "item-X" });
    const n = await markActedAllForTarget(mockDb as unknown as TestDb, "event", "e-1");
    expect(n).toBe(1);
  });
});

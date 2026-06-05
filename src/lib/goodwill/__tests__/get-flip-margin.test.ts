/**
 * Tests for G remainder (Dev backlog 2026-06-05) — the goodwill_config-
 * driven flip margin lookup. Validates the three fallback paths:
 *   - Row present     → return the row's flipMargin.
 *   - Empty result    → return RELIABILITY_FLIP_MARGIN (0.2).
 *   - Query throws    → return RELIABILITY_FLIP_MARGIN (0.2).
 *
 * Mocks the Drizzle chain shape (select → from → where → limit) the same
 * way reliability-resolution's lookupReliability tests do at the
 * route-layer level. We don't reach into a real in-memory SQLite here
 * because the fallback behavior is the point: production traffic must
 * stay correct even when the migration hasn't applied yet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFlipMargin } from "../get-flip-margin";
import { RELIABILITY_FLIP_MARGIN } from "../reliability-resolution";
import type { Database } from "@/lib/db";

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

function makeMockDb(behavior: "row" | "empty" | "throws", value = 0.35): MockDb {
  const db: MockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  switch (behavior) {
    case "row":
      db.limit.mockResolvedValueOnce([{ flipMargin: value }]);
      break;
    case "empty":
      db.limit.mockResolvedValueOnce([]);
      break;
    case "throws":
      db.limit.mockRejectedValueOnce(new Error("D1_ERROR: no such table: goodwill_config"));
      break;
  }
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getFlipMargin", () => {
  it("returns the row's flipMargin when goodwill_config row id=1 exists", async () => {
    const db = makeMockDb("row", 0.35);
    const margin = await getFlipMargin(db as unknown as Database);
    expect(margin).toBe(0.35);
  });

  it("returns RELIABILITY_FLIP_MARGIN (0.2) when row id=1 is missing", async () => {
    const db = makeMockDb("empty");
    const margin = await getFlipMargin(db as unknown as Database);
    expect(margin).toBe(RELIABILITY_FLIP_MARGIN);
    expect(margin).toBe(0.2);
  });

  it("returns RELIABILITY_FLIP_MARGIN (0.2) when the query throws (pre-migration)", async () => {
    const db = makeMockDb("throws");
    const margin = await getFlipMargin(db as unknown as Database);
    expect(margin).toBe(RELIABILITY_FLIP_MARGIN);
    expect(margin).toBe(0.2);
  });
});

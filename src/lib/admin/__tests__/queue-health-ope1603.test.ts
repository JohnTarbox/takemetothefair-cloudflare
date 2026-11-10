import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatQueueAge, loadQueueHealth, type QueueTile } from "../queue-health";

vi.mock("@/lib/logger", () => ({ logError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/correspondents/briefing", () => ({
  buildCorrespondentBriefing: vi.fn(async () => ({
    waiting: [{ receivedAt: new Date("2026-11-08T12:00:00Z") }],
  })),
}));
vi.mock("@/lib/duplicates/flag-queue", () => ({
  DUPLICATE_FLAGS_PATH: "/admin/duplicates/flags",
  loadDuplicateFlagFlow: vi.fn(async () => ({
    depth: 2,
    inflow7d: 1,
    outflow7d: 3,
    oldestOpenAt: new Date("2026-11-07T12:00:00Z"),
  })),
}));

const NOW = new Date("2026-11-09T12:00:00Z");

/** Each .select() chain resolves to the next scripted result set. */
function fakeDb(rows: () => unknown[]) {
  const chain = { from: () => chain, where: () => Promise.resolve(rows()) };
  return { select: () => chain } as never;
}

const byKey = (tiles: QueueTile[], key: string) => tiles.find((t) => t.key === key) as QueueTile;

describe("loadQueueHealth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the eight queues, each linking somewhere", async () => {
    const tiles = await loadQueueHealth(
      fakeDb(() => [{ n: 5, oldest: null }]),
      NOW
    );
    expect(tiles.map((t) => t.key)).toEqual([
      "submissions",
      "claims",
      "duplicates",
      "inbound",
      "problem-reports",
      "correspondents",
      "discrepancies",
      "enrichment",
    ]);
    expect(tiles.every((t) => t.href.startsWith("/admin/"))).toBe(true);
    expect(byKey(tiles, "inbound").href).toContain("status=awaiting_human");
  });

  it("reports the oldest item's age and leaves unknown flows as null", async () => {
    const oldest = NOW.getTime() / 1000 - 3 * 3600;
    const tiles = await loadQueueHealth(
      fakeDb(() => [{ n: 4, oldest }]),
      NOW
    );
    expect(byKey(tiles, "claims")).toMatchObject({ actionable: 4, in7d: 4, out7d: 4 });
    expect(byKey(tiles, "claims").oldestAgeHours).toBeCloseTo(3);
    expect(byKey(tiles, "inbound").out7d).toBeNull();
    expect(byKey(tiles, "correspondents")).toMatchObject({ actionable: 1, in7d: null });
    expect(byKey(tiles, "correspondents").oldestAgeHours).toBeCloseTo(24);
  });

  it("sums the enrichment tables and takes the oldest of the three", async () => {
    const tiles = await loadQueueHealth(
      fakeDb(() => [{ n: 2, oldest: 1000 }]),
      NOW
    );
    expect(byKey(tiles, "enrichment").actionable).toBe(6);
    expect(byKey(tiles, "enrichment").in7d).toBe(6);
  });

  it("shows a failed read as unknown, not zero, and keeps the other tiles", async () => {
    let call = 0;
    const db = fakeDb(() => {
      call += 1;
      if (call === 1) throw new Error("D1 overloaded");
      return [{ n: 1, oldest: null }];
    });
    const tiles = await loadQueueHealth(db, NOW);
    expect(byKey(tiles, "submissions").actionable).toBeNull();
    expect(byKey(tiles, "claims").actionable).toBe(1);
  });
});

describe("formatQueueAge", () => {
  it("reads naturally at each scale", () => {
    expect([null, 0.5, 5, 47, 48, 100].map(formatQueueAge)).toEqual([
      "—",
      "<1h",
      "5h",
      "47h",
      "2d",
      "4d",
    ]);
  });
});

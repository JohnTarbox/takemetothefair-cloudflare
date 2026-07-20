/**
 * OPE-225 — the photo-coverage endpoint.
 *
 * The invariant worth pinning is that `?limit=` truncates ONLY the backlog
 * list. A limit that also shrank the tier rollups would make the headline
 * coverage numbers depend on a paging parameter — the dashboard would read
 * "2 imageless" because someone passed limit=2, which is exactly the kind of
 * flattering-but-wrong number this rail exists to eliminate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let storedRows: unknown[] = [];
let authorized = true;

vi.mock("@/lib/api-auth", () => ({ isAuthorized: async () => authorized }));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => ({
    select: () => ({ from: async () => storedRows }),
  }),
}));

const { GET } = await import("../route");

const NOW = new Date("2026-07-20T00:00:00Z");
const stateRow = (over: Record<string, unknown> = {}) => ({
  entityType: "EVENT",
  entityId: "e1",
  slug: "fryeburg-fair",
  hasImage: false,
  imageUrl: null,
  urlHealth: "MISSING",
  imageSetAt: null,
  baselineHadImage: false,
  firstSeenAt: NOW,
  demandImpressions: 0,
  demandTier: "T4",
  checkedAt: NOW,
  ...over,
});

const call = (qs = "") =>
  GET(new Request(`https://x.test/api/admin/analytics/photo-coverage${qs}`) as never);

beforeEach(() => {
  authorized = true;
  storedRows = [];
});

describe("GET /api/admin/analytics/photo-coverage", () => {
  it("401s without an admin session or internal key", async () => {
    authorized = false;
    expect((await call()).status).toBe(401);
  });

  it("limit truncates the backlog but NOT the tier rollups", async () => {
    storedRows = [
      stateRow({ entityId: "a", demandImpressions: 900, demandTier: "T1" }),
      stateRow({ entityId: "b", demandImpressions: 800, demandTier: "T1" }),
      stateRow({ entityId: "c", demandImpressions: 700, demandTier: "T1" }),
    ];
    const body = await (await call("?limit=1")).json();

    expect(body.imagelessByDemand).toHaveLength(1);
    expect(body.imagelessByDemand[0].entityId).toBe("a"); // highest demand first
    // The headline numbers still see all three.
    const events = body.byEntity.find((e: { entityType: string }) => e.entityType === "EVENT");
    expect(events.imageless).toBe(3);
    expect(events.byTier.find((t: { tier: string }) => t.tier === "T1").total).toBe(3);
  });

  it("surfaces lastScanAt so stale numbers are distinguishable from live ones", async () => {
    const older = new Date("2026-07-18T00:00:00Z");
    storedRows = [
      stateRow({ entityId: "a", checkedAt: older }),
      stateRow({ entityId: "b", checkedAt: NOW }),
    ];
    const body = await (await call()).json();
    expect(body.lastScanAt).toBe(NOW.toISOString());
  });

  it("reports an empty table as 0/0 rather than omitting entity types", async () => {
    const body = await (await call()).json();
    expect(body.scannedEntities).toBe(0);
    expect(body.byEntity.map((e: { entityType: string }) => e.entityType)).toEqual([
      "EVENT",
      "VENDOR",
      "VENUE",
      "PROMOTER",
      "PERFORMER",
    ]);
    expect(body.lastScanAt).toBeNull();
  });

  it("counts hotlinked URLs for the §4 health signal", async () => {
    storedRows = [
      stateRow({ entityId: "a", hasImage: true, urlHealth: "HOTLINKED" }),
      stateRow({ entityId: "b", hasImage: true, urlHealth: "OWNED" }),
    ];
    const body = await (await call()).json();
    expect(body.urlHealth.hotlinked).toBe(1);
    expect(body.urlHealth.owned).toBe(1);
  });
});

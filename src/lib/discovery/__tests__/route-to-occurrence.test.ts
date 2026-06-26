/**
 * K34 / EH3 P3.3b — maybeRouteToOccurrence decision wiring.
 *
 * findDuplicate + createOccurrenceForSeries are mocked so we test the routing
 * decision (and the matched-event series/year/vendor lookups) in isolation; the
 * pure routing rules live in discovery-routing.test.ts and the insert in
 * create-occurrence.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";

vi.mock("@/lib/duplicates/find-duplicate", () => ({ findDuplicate: vi.fn() }));
vi.mock("@/lib/series/create-occurrence", () => ({ createOccurrenceForSeries: vi.fn() }));

import { findDuplicate } from "@/lib/duplicates/find-duplicate";
import { createOccurrenceForSeries } from "@/lib/series/create-occurrence";
import { maybeRouteToOccurrence } from "../route-to-occurrence";

const mockFindDup = vi.mocked(findDuplicate);
const mockCreate = vi.mocked(createOccurrenceForSeries);

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    series_id TEXT,
    start_date INTEGER,
    rolled_from_event_id TEXT
  );
  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  mockFindDup.mockReset();
  mockCreate.mockReset();
});
afterEach(() => raw.close());

function seedMatched(opts: {
  id: string;
  seriesId: string | null;
  startIso: string | null;
  rolledFrom?: string | null;
  vendors?: number;
}) {
  raw
    .prepare(
      `INSERT INTO events (id, series_id, start_date, rolled_from_event_id) VALUES (?, ?, ?, ?)`
    )
    .run(
      opts.id,
      opts.seriesId,
      opts.startIso ? Math.floor(new Date(opts.startIso).getTime() / 1000) : null,
      opts.rolledFrom ?? null
    );
  for (let i = 0; i < (opts.vendors ?? 0); i++) {
    raw
      .prepare(`INSERT INTO event_vendors (id, event_id, vendor_id) VALUES (?, ?, ?)`)
      .run(`ev${opts.id}${i}`, opts.id, `v${i}`);
  }
}

const dupHit = (id: string) => ({
  isDuplicate: true as const,
  matchType: "exact_url" as const,
  existingEvent: { id, slug: "s", name: "n", startDate: null, status: "APPROVED", sourceUrl: null },
});

describe("maybeRouteToOccurrence", () => {
  it("returns routed:false with no startDate (no year to bucket)", async () => {
    const res = await maybeRouteToOccurrence(db as never, { startDate: null });
    expect(res.routed).toBe(false);
    expect(mockFindDup).not.toHaveBeenCalled();
  });

  it("returns routed:false when findDuplicate finds nothing", async () => {
    mockFindDup.mockResolvedValue({ isDuplicate: false });
    const res = await maybeRouteToOccurrence(db as never, {
      startDate: new Date("2027-08-01T00:00:00Z"),
    });
    expect(res.routed).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("routes a different-year edition of a SERIESed match to a new occurrence", async () => {
    seedMatched({ id: "evt1", seriesId: "series-cheshire", startIso: "2026-08-01T00:00:00Z" });
    mockFindDup.mockResolvedValue(dupHit("evt1"));
    mockCreate.mockResolvedValue({
      created: true,
      occurrenceId: "occ1",
      slug: "cheshire-fair-2027",
      year: 2027,
    });

    const res = await maybeRouteToOccurrence(db as never, {
      startDate: new Date("2027-08-01T00:00:00Z"),
      name: "Cheshire Fair",
    });

    expect(res.routed).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ seriesId: "series-cheshire", year: 2027 })
    );
  });

  it("does NOT route when the match has no series (today's standalone behaviour)", async () => {
    seedMatched({ id: "evt1", seriesId: null, startIso: "2026-08-01T00:00:00Z" });
    mockFindDup.mockResolvedValue(dupHit("evt1"));
    const res = await maybeRouteToOccurrence(db as never, {
      startDate: new Date("2027-08-01T00:00:00Z"),
    });
    expect(res.routed).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does NOT route a SAME-year match (genuine duplicate, not a new edition)", async () => {
    seedMatched({ id: "evt1", seriesId: "series-cheshire", startIso: "2027-08-01T00:00:00Z" });
    mockFindDup.mockResolvedValue(dupHit("evt1"));
    const res = await maybeRouteToOccurrence(db as never, {
      startDate: new Date("2027-08-15T00:00:00Z"),
    });
    expect(res.routed).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does NOT route a vendor-bearing match (too risky to auto-attach)", async () => {
    seedMatched({ id: "evt1", seriesId: "series-x", startIso: "2026-08-01T00:00:00Z", vendors: 3 });
    mockFindDup.mockResolvedValue(dupHit("evt1"));
    const res = await maybeRouteToOccurrence(db as never, {
      startDate: new Date("2027-08-01T00:00:00Z"),
    });
    expect(res.routed).toBe(false);
  });
});

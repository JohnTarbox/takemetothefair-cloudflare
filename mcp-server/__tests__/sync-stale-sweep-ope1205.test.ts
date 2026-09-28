/**
 * OPE-1205 — the sync-staleness sweep: a synced row whose source went quiet
 * stops claiming confirmed dates, unless a qualifying citation backs them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  runSyncStaleSweep,
  SYNC_STALE_DOWNGRADE_ACTION,
  SYNC_STALE_RUN_ACTION,
} from "../src/sync-stale-sweep.js";
import {
  adminActions,
  eventDataCitations,
  events,
  promoters,
  tunableThresholds,
} from "../src/schema.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
let db: TestDb;

beforeEach(() => {
  ({ db } = createTestDb());
  db.insert(promoters)
    .values({ id: "p1", companyName: "P", slug: unsafeSlug("p") })
    .run();
});

function seed(id: string, o: Partial<typeof events.$inferInsert> = {}) {
  db.insert(events)
    .values({
      id,
      name: `Event ${id}`,
      slug: unsafeSlug(`event-${id}`),
      promoterId: "p1",
      status: "APPROVED",
      startDate: new Date("2026-10-31T12:00:00Z"),
      endDate: new Date("2026-11-01T12:00:00Z"),
      datesConfirmed: true,
      syncEnabled: true,
      lastSyncedAt: daysAgo(200),
      createdAt: daysAgo(300),
      ...o,
    })
    .run();
}
function cite(eventId: string, url: string, type = "official_website") {
  db.insert(eventDataCitations)
    .values({
      id: `c-${eventId}`,
      eventId,
      fieldName: "start_date",
      value: "2026-10-31",
      sourceUrl: url,
      sourceType: type as never,
      state: "active",
    } as never)
    .run();
}
const confirmed = (id: string) =>
  db.select({ v: events.datesConfirmed }).from(events).where(eq(events.id, id)).all()[0].v;

describe("runSyncStaleSweep", () => {
  it("ACCEPTANCE: a row synced 200 days ago with no citation is downgraded, and logged", async () => {
    seed("stale");
    const r = await runSyncStaleSweep(db, NOW);
    expect(r.downgraded).toEqual(["stale"]);
    expect(confirmed("stale")).toBe(false);
    const logged = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, SYNC_STALE_DOWNGRADE_ACTION))
      .all();
    expect(logged.map((a) => a.targetId)).toEqual(["stale"]);
  });

  it("ACCEPTANCE: the same row WITH an active organizer citation is left alone", async () => {
    seed("cited");
    cite("cited", "https://www.castleberryfairs.com/harvest");
    const r = await runSyncStaleSweep(db, NOW);
    expect(r.downgraded).toEqual([]);
    expect(r.exemptCited).toBe(1);
    expect(confirmed("cited")).toBe(true);
  });

  it("an aggregator-only citation does not exempt it (the OPE-1200 rule)", async () => {
    seed("agg");
    cite("agg", "https://www.lakesregion.org/events/x");
    expect((await runSyncStaleSweep(db, NOW)).downgraded).toEqual(["agg"]);
  });

  it("recent syncs, unsynced rows, past events and already-unconfirmed rows are untouched", async () => {
    seed("recent", { lastSyncedAt: daysAgo(10) });
    seed("not-synced", { syncEnabled: false });
    seed("past", { startDate: daysAgo(30), endDate: daysAgo(29) });
    seed("unconfirmed", { datesConfirmed: false });
    const r = await runSyncStaleSweep(db, NOW);
    expect(r.downgraded).toEqual([]);
    expect(confirmed("recent")).toBe(true);
  });

  it("a never-synced row ages from its creation", async () => {
    seed("never", { lastSyncedAt: null, createdAt: daysAgo(120) });
    expect((await runSyncStaleSweep(db, NOW)).downgraded).toEqual(["never"]);
  });

  it("the tunable threshold is read from tunable_thresholds", async () => {
    db.insert(tunableThresholds)
      .values({ key: "sync_stale_dates_confirmed_days", value: 365, unit: "days" })
      .run();
    seed("stale");
    const r = await runSyncStaleSweep(db, NOW);
    expect(r.thresholdDays).toBe(365);
    expect(r.downgraded).toEqual([]);
  });

  it("every run writes its run row (heartbeat evidence), even when nothing is stale", async () => {
    await runSyncStaleSweep(db, NOW);
    const runs = db
      .select()
      .from(adminActions)
      .where(eq(adminActions.action, SYNC_STALE_RUN_ACTION))
      .all();
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0].payloadJson!)).toMatchObject({
      thresholdDays: 90,
      candidates: 0,
      downgraded: 0,
    });
  });
});

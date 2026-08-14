/**
 * OPE-370 — the ping queue enforces its own retention decision.
 *
 * The queue was accumulating rows already condemned by a standing ruling
 * (John, 2026-07-18: discard >7d at breaker-clear) while the IndexNow breaker
 * kept anything from being submitted. Measured in prod 2026-08-13: 7,764
 * unflushed rows, 45 of them within 7 days — a depth that read like a backlog
 * while being 99.4% garbage.
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./setup-db.js";
import { pendingSearchPings } from "../src/schema.js";
import { prunePendingPings } from "../src/pending-pings.js";
import { SEARCH_PING_RETENTION_DAYS, searchPingRetentionDays } from "@takemetothefair/constants";

const NOW = new Date("2026-08-13T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400 * 1000);

type Row = { id: string; ago: number; flushed?: boolean };

async function seed(db: ReturnType<typeof createTestDb>["db"], rows: Row[]) {
  for (const r of rows) {
    await db.insert(pendingSearchPings).values({
      id: r.id,
      entityType: "event",
      entityId: `e-${r.id}`,
      entitySlug: `slug-${r.id}`,
      action: "update",
      queuedAt: daysAgo(r.ago),
      flushedAt: r.flushed ? daysAgo(r.ago) : null,
    });
  }
}

const remaining = async (db: ReturnType<typeof createTestDb>["db"]) =>
  (await db.select({ id: pendingSearchPings.id }).from(pendingSearchPings)).map((r) => r.id).sort();

describe("OPE-370 — rolling retention window", () => {
  it("drops un-submitted pings past the window, keeps the fresh ones", async () => {
    const { db } = createTestDb();
    await seed(db, [
      { id: "old1", ago: 60 }, // the June-era backlog
      { id: "old2", ago: 8 },
      { id: "edge", ago: 7.5 },
      { id: "fresh1", ago: 6 },
      { id: "fresh2", ago: 0 },
    ]);

    const pruned = await prunePendingPings(db, NOW, SEARCH_PING_RETENTION_DAYS);
    expect(pruned).toBe(3);
    expect(await remaining(db)).toEqual(["fresh1", "fresh2"]);
  });

  it("NEVER deletes a flushed row — that is an audit trail, not a queue", async () => {
    // A flushed row records a submission that actually happened. Pruning it
    // would destroy the evidence rather than tidy the backlog.
    const { db } = createTestDb();
    await seed(db, [
      { id: "flushed-ancient", ago: 90, flushed: true },
      { id: "unflushed-ancient", ago: 90 },
    ]);

    const pruned = await prunePendingPings(db, NOW, SEARCH_PING_RETENTION_DAYS);
    expect(pruned).toBe(1);
    expect(await remaining(db)).toEqual(["flushed-ancient"]);
  });

  it("is idempotent — a second run in the same window prunes nothing", async () => {
    const { db } = createTestDb();
    await seed(db, [
      { id: "old", ago: 30 },
      { id: "fresh", ago: 1 },
    ]);

    expect(await prunePendingPings(db, NOW, SEARCH_PING_RETENTION_DAYS)).toBe(1);
    expect(await prunePendingPings(db, NOW, SEARCH_PING_RETENTION_DAYS)).toBe(0);
    expect(await remaining(db)).toEqual(["fresh"]);
  });

  it("reports 0 rather than throwing on an empty queue", async () => {
    const { db } = createTestDb();
    expect(await prunePendingPings(db, NOW, SEARCH_PING_RETENTION_DAYS)).toBe(0);
  });

  it("honours a widened window — the figure is a decision, not a constant", async () => {
    const { db } = createTestDb();
    await seed(db, [
      { id: "d10", ago: 10 },
      { id: "d40", ago: 40 },
    ]);

    // At 30 days the 10-day-old row survives; only the 40-day one goes.
    expect(await prunePendingPings(db, NOW, 30)).toBe(1);
    expect(await remaining(db)).toEqual(["d10"]);
  });
});

describe("OPE-370 — the threshold is single-sourced and overridable", () => {
  it("defaults to the shared constant", () => {
    expect(searchPingRetentionDays({})).toBe(SEARCH_PING_RETENTION_DAYS);
  });

  it("rejects nonsense rather than pruning everything", () => {
    // A 0 or negative window would delete the entire queue on the next cron.
    expect(searchPingRetentionDays({ SEARCH_PING_RETENTION_DAYS: "0" })).toBe(
      SEARCH_PING_RETENTION_DAYS
    );
    expect(searchPingRetentionDays({ SEARCH_PING_RETENTION_DAYS: "-5" })).toBe(
      SEARCH_PING_RETENTION_DAYS
    );
    expect(searchPingRetentionDays({ SEARCH_PING_RETENTION_DAYS: "banana" })).toBe(
      SEARCH_PING_RETENTION_DAYS
    );
  });

  it("honours a real override", () => {
    expect(searchPingRetentionDays({ SEARCH_PING_RETENTION_DAYS: "30" })).toBe(30);
  });
});

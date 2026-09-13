/**
 * OPE-971 — request_samples retention runs on a schedule, deletes in bounded
 * batches, leaves in-window rows alone, and records what it did.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { agentHeartbeats, errorLogs } from "../src/schema.js";
import {
  REQUEST_SAMPLE_RETENTION_CODE,
  runRequestSampleRetention,
} from "../src/request-sample-retention.js";
import type Database from "better-sqlite3";

const NOW = new Date("2026-09-13T06:00:00Z");
const DAY = 86_400_000;
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

let db: TestDb;
let raw: Database.Database;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw["exec"](`CREATE TABLE IF NOT EXISTS request_samples (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, path TEXT, method TEXT, user_agent TEXT,
    ip TEXT, asn INTEGER, as_organization TEXT, country TEXT, referer TEXT, ray TEXT)`);
});

function seed(prefix: string, n: number, ageDays: number) {
  const ins = raw.prepare("INSERT INTO request_samples (id, timestamp) VALUES (?, ?)");
  for (let i = 0; i < n; i++)
    ins.run(`${prefix}-${i}`, sec(new Date(NOW.getTime() - ageDays * DAY)));
}
const count = (where = "1=1") =>
  (raw.prepare(`SELECT COUNT(*) n FROM request_samples WHERE ${where}`).get() as { n: number }).n;
const stamp = async () =>
  (
    await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, REQUEST_SAMPLE_RETENTION_CODE))
  )[0];

describe("OPE-971 — scheduled retention", () => {
  it("ACCEPTANCE: deletes rows past the window, in batches; oldest remaining is inside the window after", async () => {
    seed("old", 1234, 75);
    seed("edge-in", 3, 59.9); // just inside
    seed("new", 10, 1);
    const minBefore = (
      raw.prepare("SELECT MIN(timestamp) t FROM request_samples").get() as { t: number }
    ).t;

    const r = await runRequestSampleRetention(db as never, { now: NOW, batch: 500 });

    expect(r).toMatchObject({
      deleted: 1234,
      batches: 3,
      capped: false,
      windowExceeded: false,
      errors: 0,
    });
    expect(new Date(minBefore * 1000).getTime()).toBeLessThan(NOW.getTime() - 60 * DAY);
    expect(new Date(r.oldestRemaining!).getTime()).toBeGreaterThanOrEqual(NOW.getTime() - 60 * DAY);
    // POSITIVE LANDMARK: in-window rows survive the same run.
    expect(count("id LIKE 'edge-in-%'")).toBe(3);
    expect(count("id LIKE 'new-%'")).toBe(10);
  });

  it("records the run — deleted count, oldest row — even when nothing aged out", async () => {
    seed("new", 5, 2);
    const r = await runRequestSampleRetention(db as never, { now: NOW });
    expect(r.deleted).toBe(0);
    const s = await stamp();
    expect(s?.lastSeenAt?.getTime()).toBe(NOW.getTime());
    expect(s?.note).toMatch(/deleted=0 batches=1 capped=false oldest=2026-09-11/);
  });

  it("the NEXT day's run refreshes the same stamp — what the probe reads", async () => {
    await runRequestSampleRetention(db as never, { now: NOW });
    const tomorrow = new Date(NOW.getTime() + DAY);
    seed("aged", 2, 61 - 1); // ages past the window by tomorrow
    await runRequestSampleRetention(db as never, { now: tomorrow });
    const s = await stamp();
    expect(s?.lastSeenAt?.getTime()).toBe(tomorrow.getTime());
    expect(s?.note).toMatch(/deleted=2/);
  });

  it("DRIVEN TO FAILURE: a future cutoff makes every row qualify; the loop deletes all and terminates", async () => {
    seed("a", 1001, 1);
    seed("b", 250, 0);
    const r = await runRequestSampleRetention(db as never, {
      now: NOW,
      cutoff: new Date(NOW.getTime() + DAY),
      batch: 100,
    });
    expect(r).toMatchObject({ deleted: 1251, batches: 13, capped: false, oldestRemaining: null });
    expect(count()).toBe(0);
  });

  it("the batch cap stops a runaway loop and SAYS the window is still exceeded", async () => {
    seed("old", 350, 90);
    const r = await runRequestSampleRetention(db as never, { now: NOW, batch: 100, maxBatches: 2 });
    expect(r).toMatchObject({ deleted: 200, capped: true, windowExceeded: true });
    const warns = await db.select().from(errorLogs);
    expect(warns.map((w) => w.message).join("\n")).toMatch(/retention incomplete/);
  });

  it("a delete that throws is reported and the run is still stamped", async () => {
    seed("old", 5, 90);
    const broken = new Proxy(db as object, {
      get(t, k) {
        if (k === "delete")
          return () => {
            throw new Error("D1 timeout");
          };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const r = await runRequestSampleRetention(broken as never, { now: NOW });
    expect(r.errors).toBe(1);
    expect(r.windowExceeded).toBe(true);
    expect((await stamp())?.note).toMatch(/errors=1/);
    vi.restoreAllMocks();
  });
});

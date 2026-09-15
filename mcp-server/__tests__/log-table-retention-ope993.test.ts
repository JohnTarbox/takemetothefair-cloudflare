/**
 * OPE-993 — error_logs and indexnow_submissions retention runs on the daily
 * cron, deletes in bounded batches, leaves in-window rows alone, stamps its
 * run on success (0 deleted included) and does NOT stamp when the prune fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { agentHeartbeats, errorLogs } from "../src/schema.js";
import {
  ERROR_LOG_RETENTION_CODE,
  INDEXNOW_SUBMISSION_RETENTION_CODE,
  runErrorLogRetention,
  runIndexNowSubmissionRetention,
  type LogRetentionOptions,
  type LogRetentionResult,
} from "../src/log-table-retention.js";
import type { Db } from "../src/db.js";
import type Database from "better-sqlite3";

const NOW = new Date("2026-09-13T06:00:00Z");
const DAY = 86_400_000;
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

let db: TestDb;
let raw: Database.Database;
let statements: string[];

beforeEach(() => {
  ({ db, raw } = createTestDb());
  statements = [];
  const originalPrepare = raw.prepare.bind(raw);
  (raw as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => {
    statements.push(s);
    return originalPrepare(s);
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Case {
  table: "error_logs" | "indexnow_submissions";
  code: string;
  source: string;
  run: (db: Db, opts?: LogRetentionOptions) => Promise<LogRetentionResult>;
  insert: (id: string, ts: number) => void;
}

const CASES: Case[] = [
  {
    table: "error_logs",
    code: ERROR_LOG_RETENTION_CODE,
    source: "mcp:error-log-retention",
    run: runErrorLogRetention,
    insert: (id, ts) =>
      raw
        .prepare("INSERT INTO error_logs (id, timestamp, level, message) VALUES (?, ?, 'error', ?)")
        .run(id, ts, `seed ${id}`),
  },
  {
    table: "indexnow_submissions",
    code: INDEXNOW_SUBMISSION_RETENTION_CODE,
    source: "mcp:indexnow-submission-retention",
    run: runIndexNowSubmissionRetention,
    insert: (id, ts) =>
      raw
        .prepare(
          "INSERT INTO indexnow_submissions (id, timestamp, source, status) VALUES (?, ?, 'test', 'success')"
        )
        .run(id, ts),
  },
];

for (const c of CASES) {
  const seed = (prefix: string, n: number, ageDays: number) => {
    const ts = sec(new Date(NOW.getTime() - ageDays * DAY));
    raw.transaction(() => {
      for (let i = 0; i < n; i++) c.insert(`${prefix}-${i}`, ts);
    })();
  };
  // Seeded ids all carry a '-<n>' suffix; the run's own log rows are UUIDs.
  const count = (where = "1=1") =>
    (raw.prepare(`SELECT COUNT(*) n FROM ${c.table} WHERE ${where}`).get() as { n: number }).n;
  const stamp = async () =>
    (await db.select().from(agentHeartbeats).where(eq(agentHeartbeats.agentCode, c.code)))[0];
  const logsFrom = async () =>
    (await db.select().from(errorLogs)).filter((r) => r.source === c.source);

  describe(`OPE-993 — ${c.table} scheduled retention`, () => {
    it("ACCEPTANCE: deletes rows past 30 days in batches; in-window rows survive", async () => {
      seed("old", 1234, 45);
      seed("edge-out", 2, 30.01); // just past the window
      seed("edge-in", 3, 29.9); // POSITIVE LANDMARK: just inside
      seed("new", 10, 1);

      const r = await c.run(db as never, { now: NOW, batch: 500 });

      expect(r).toMatchObject({
        table: c.table,
        deleted: 1236,
        batches: 3,
        capped: false,
        windowExceeded: false,
        ok: true,
        stamped: true,
      });
      expect(r.cutoff).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
      expect(count("id LIKE 'old-%' OR id LIKE 'edge-out-%'")).toBe(0);
      expect(count("id LIKE 'edge-in-%'")).toBe(3);
      expect(count("id LIKE 'new-%'")).toBe(10);
      expect(new Date(r.oldestRemaining!).getTime()).toBeGreaterThanOrEqual(
        NOW.getTime() - 30 * DAY
      );
      // Rows deleted are logged at level info.
      const info = (await logsFrom()).filter((l) => l.level === "info");
      expect(info.map((l) => l.message).join("\n")).toMatch(
        new RegExp(`${c.table} retention: deleted=1236 batches=3`)
      );
    });

    it("stamps the run even when nothing aged out (0 deleted)", async () => {
      seed("new", 5, 2);
      const r = await c.run(db as never, { now: NOW });
      expect(r).toMatchObject({ deleted: 0, batches: 1, ok: true, stamped: true });
      const s = await stamp();
      expect(s?.lastSeenAt?.getTime()).toBe(NOW.getTime());
      expect(s?.kind).toBe("watchdog");
      expect(s?.note).toMatch(/^deleted=0 batches=1 capped=false oldest=2026-09-11/);
      // OPE-1024 — the same fields as request-sample-retention's stamp.
      expect(s?.note).toMatch(/ cutoff=\S+ errors=0$/);
    });

    it("stamps the run on an EMPTY table", async () => {
      const r = await c.run(db as never, { now: NOW });
      expect(r).toMatchObject({ deleted: 0, oldestRemaining: null, stamped: true });
      expect((await stamp())?.lastSeenAt?.getTime()).toBe(NOW.getTime());
    });

    it("the NEXT day's run refreshes the same stamp — what the probe reads", async () => {
      await c.run(db as never, { now: NOW });
      const tomorrow = new Date(NOW.getTime() + DAY);
      seed("aged", 2, 29.5); // past the window by tomorrow
      await c.run(db as never, { now: tomorrow });
      const s = await stamp();
      expect(s?.lastSeenAt?.getTime()).toBe(tomorrow.getTime());
      expect(s?.note).toMatch(/deleted=2/);
      expect(count("id LIKE 'aged-%'")).toBe(0);
    });

    it("the batch cap stops a runaway loop, warns, and still stamps a successful run", async () => {
      seed("old", 350, 90);
      const r = await c.run(db as never, { now: NOW, batch: 100, maxBatches: 2 });
      expect(r).toMatchObject({ deleted: 200, capped: true, windowExceeded: true, stamped: true });
      const warns = (await logsFrom()).filter((l) => l.level === "warn");
      expect(warns.map((w) => w.message).join("\n")).toMatch(/retention incomplete — batch cap/);
      expect(count("id LIKE 'old-%'")).toBe(150);
    });

    it("statement shape: the DELETE binds a constant number of params regardless of rows deleted", async () => {
      seed("old", 1200, 60);
      statements.length = 0;
      await c.run(db as never, { now: NOW, batch: 500 });
      const deletes = statements.filter((s) => /^\s*delete from/i.test(s));
      expect(deletes.length).toBe(3);
      for (const d of deletes) {
        // cutoff + LIMIT — the id list is a subquery, never bound values.
        expect((d.match(/\?/g) ?? []).length).toBeLessThanOrEqual(2);
        expect(d).toMatch(/in \(select/i);
      }
    });
  });
}

describe("OPE-993 — DRIVEN TO FAILURE: a broken prune does NOT stamp and logs an error", () => {
  it("indexnow_submissions: table dropped → no stamp, error row written", async () => {
    raw.exec("DROP TABLE indexnow_submissions");
    const r = await runIndexNowSubmissionRetention(db as never, { now: NOW });
    expect(r).toMatchObject({ ok: false, stamped: false, deleted: 0 });
    const s = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, INDEXNOW_SUBMISSION_RETENTION_CODE));
    expect(s).toHaveLength(0);
    const errs = (await db.select().from(errorLogs)).filter(
      (l) => l.source === "mcp:indexnow-submission-retention"
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].level).toBe("error");
    expect(errs[0].message).toMatch(
      /indexnow_submissions retention failed \(run NOT stamped\).*no such table: indexnow_submissions/
    );
    console.log(`[drill] indexnow_submissions: ${JSON.stringify(r)} :: ${errs[0].message}`);
  });

  it("error_logs: table dropped → no stamp, error reaches the console (the log table itself is gone)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    raw.exec("DROP TABLE error_logs");
    const r = await runErrorLogRetention(db as never, { now: NOW });
    expect(r).toMatchObject({ ok: false, stamped: false });
    const s = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, ERROR_LOG_RETENTION_CODE));
    expect(s).toHaveLength(0);
    const msgs = spy.mock.calls.map((a) => String(a[0]));
    const hit = msgs.find((m) => /error_logs retention failed \(run NOT stamped\)/.test(m));
    expect(hit).toMatch(/no such table: error_logs/);
    spy.mockRestore();
    console.log(`[drill] error_logs(dropped): ${JSON.stringify(r)} :: ${hit}`);
  });

  it("error_logs: delete throws but the log table is intact → no stamp, error ROW written", async () => {
    raw
      .prepare(
        "INSERT INTO error_logs (id, timestamp, level, message) VALUES ('old-1', ?, 'error', 'x')"
      )
      .run(sec(new Date(NOW.getTime() - 90 * DAY)));
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
    const r = await runErrorLogRetention(broken as never, { now: NOW });
    expect(r).toMatchObject({ ok: false, stamped: false });
    const s = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, ERROR_LOG_RETENTION_CODE));
    expect(s).toHaveLength(0);
    const errs = (await db.select().from(errorLogs)).filter(
      (l) => l.source === "mcp:error-log-retention"
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/error_logs retention failed \(run NOT stamped\).*D1 timeout/);
  });

  it("a failed run does not REFRESH yesterday's stamp — the probe ages out", async () => {
    await runIndexNowSubmissionRetention(db as never, { now: NOW });
    raw.exec("DROP TABLE indexnow_submissions");
    await runIndexNowSubmissionRetention(db as never, { now: new Date(NOW.getTime() + DAY) });
    const [s] = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, INDEXNOW_SUBMISSION_RETENTION_CODE));
    expect(s.lastSeenAt?.getTime()).toBe(NOW.getTime());
  });
});

/**
 * OPE-1664 — an error_logs row whose D1 insert fails is buffered in KV and
 * replayed into error_logs by /api/internal/error-log-buffer/replay with its
 * ORIGINAL timestamp and `context.replayedFromBuffer`.
 *
 * The chain is driven end to end through the shipped code: the real `logError`
 * and `captureServerRenderError` against a D1 stand-in that refuses the insert,
 * then the real route handler draining into a real SQLite error_logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { NextRequest } from "next/server";
import * as schema from "../../db/schema";

const state = vi.hoisted(() => ({
  kv: null as unknown,
  db: null as unknown,
}));
vi.mock("@/lib/cloudflare", () => ({
  getCloudflareDb: () => state.db,
  getCloudflareEnv: () => ({ INTERNAL_API_KEY: "test-key" }),
  getCloudflareRateLimitKv: () => state.kv,
}));

import { logError } from "../../logger";
import { captureServerRenderError } from "../capture-render-error";
import {
  BUFFER_CAP_PER_HOUR,
  BUFFER_ROW_PREFIX,
  bufferFailedErrorLog,
  markReplayed,
  REPLAY_HEARTBEAT_CODE,
  type BufferKv,
  type ErrorLogRow,
} from "../error-log-buffer";
import { POST } from "../../../app/api/internal/error-log-buffer/replay/route";
import { readOnlyDb } from "../../test-submission/read-only-db";

/** A Map-backed KV with the list() ordering and paging Cloudflare gives. */
function fakeKv(): BufferKv & { store: Map<string, string>; failPut?: boolean } {
  const store = new Map<string, string>();
  const kv = {
    store,
    failPut: false,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      if (kv.failPut) throw new Error("KV put failed");
      store.set(k, v);
    },
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix, limit = 1000 }: { prefix: string; limit?: number }) => {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return {
        keys: names.slice(0, limit).map((name) => ({ name })),
        list_complete: names.length <= limit,
      };
    },
  };
  return kv;
}

const SCHEMA_SQL = `
  CREATE TABLE error_logs (
    id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'error',
    message TEXT NOT NULL, context TEXT DEFAULT '{}', url TEXT, method TEXT, status_code INTEGER,
    stack_trace TEXT, user_agent TEXT, source TEXT, route TEXT, digest TEXT
  );
  CREATE TABLE agent_heartbeats (
    id TEXT PRIMARY KEY, agent_code TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'agent',
    last_seen_at INTEGER NOT NULL, note TEXT
  );
`;

/** A D1 stand-in that refuses every write, the way an overloaded D1 does. */
const overloadedDb = {
  insert: () => ({
    values: async () => {
      throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
    },
  }),
} as never;

let raw: Database.Database;
let kv: ReturnType<typeof fakeKv>;
const rows = () =>
  raw.prepare(`SELECT * FROM error_logs ORDER BY timestamp`).all() as Array<{
    id: string;
    timestamp: number;
    message: string;
    source: string | null;
    route: string | null;
    digest: string | null;
    context: string;
  }>;
const bufferedKeys = () => [...kv.store.keys()].filter((k) => k.startsWith(BUFFER_ROW_PREFIX));
const replay = () =>
  POST(
    new NextRequest("http://localhost/api/internal/error-log-buffer/replay", {
      method: "POST",
      headers: { "x-internal-key": "test-key" },
    }),
    { params: Promise.resolve({}) } as never
  );

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  state.db = drizzle(raw, { schema });
  kv = fakeKv();
  state.kv = kv;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  raw.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OPE-1664 — a failed error_logs insert is buffered, then replayed", () => {
  it("ACCEPTANCE: logError + captureServerRenderError rows survive an overload with their original timestamps and the marker", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T01:04:10Z"));
    await logError(overloadedDb, {
      message: "client render failed",
      source: "client",
      digest: "3564936712",
      context: { page: "/admin/analytics" },
    });
    vi.setSystemTime(new Date("2026-11-13T01:04:11Z"));
    await captureServerRenderError(overloadedDb, {
      error: Object.assign(new Error("D1 DB is overloaded"), { digest: "3042710248" }),
      request: { path: "/events", method: "GET" },
    });

    // Nothing reached error_logs; both rows are in the buffer.
    expect(rows()).toHaveLength(0);
    expect(bufferedKeys()).toHaveLength(2);

    // D1 recovers; the cron runs 20 minutes later.
    vi.setSystemTime(new Date("2026-11-13T01:24:00Z"));
    const res = await replay();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, replayed: 2, stoppedOnError: false, remaining: 0 });

    const got = rows();
    expect(got.map((r) => r.timestamp)).toEqual([
      Date.parse("2026-11-13T01:04:10Z") / 1000,
      Date.parse("2026-11-13T01:04:11Z") / 1000,
    ]);
    expect(got[0]).toMatchObject({ source: "client", digest: "3564936712" });
    expect(got[1]).toMatchObject({
      source: "server-render",
      digest: "3042710248",
      route: "/events",
    });
    for (const r of got) expect(JSON.parse(r.context).replayedFromBuffer).toBe(true);
    // The caller's own context survives the marker.
    expect(JSON.parse(got[0].context)).toMatchObject({
      page: "/admin/analytics",
      bufferedAt: "2026-11-13T01:04:10.000Z",
    });
    expect(bufferedKeys()).toHaveLength(0);
  });

  it("a write a dry-run handle (OPE-1625 readOnlyDb) refused is NOT buffered — the replay would make it after all", async () => {
    const ro = readOnlyDb(state.db as object) as never;
    await logError(ro, { message: "audit write failed in a dry run" });
    await captureServerRenderError(ro, { error: new Error("boom"), request: { path: "/x" } });
    expect(rows()).toHaveLength(0);
    expect(bufferedKeys()).toHaveLength(0);
  });

  it("a KV accessor that THROWS does not make logError throw", async () => {
    state.kv = null;
    const throwing = () => {
      throw new Error("no Cloudflare context");
    };
    expect(
      await bufferFailedErrorLog(throwing, {
        id: "t",
        timestamp: new Date(),
        level: "error",
        message: "m",
        context: "{}",
      })
    ).toBe("no-kv");
  });

  it("a live (non-failed) write is NOT marked and NOT buffered", async () => {
    await logError(state.db as never, { message: "ordinary", source: "x" });
    expect(bufferedKeys()).toHaveLength(0);
    expect(JSON.parse(rows()[0].context).replayedFromBuffer).toBeUndefined();
  });

  it("a drain that D1 still refuses stops, keeps every row, and writes NO heartbeat stamp", async () => {
    await logError(overloadedDb, { message: "a" });
    await logError(overloadedDb, { message: "b" });
    raw["exec"](`DROP TABLE error_logs`); // D1 still refusing error_logs writes
    const body = (await (await replay()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, replayed: 0, stoppedOnError: true, remaining: 2 });
    expect(bufferedKeys()).toHaveLength(2);
    expect(raw.prepare(`SELECT COUNT(*) n FROM agent_heartbeats`).get()).toEqual({ n: 0 });
  });

  it("a completed drain stamps the probe's heartbeat, an empty buffer included", async () => {
    const body = (await (await replay()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, replayed: 0 });
    const hb = raw.prepare(`SELECT agent_code, kind, note FROM agent_heartbeats`).all() as Array<
      Record<string, string>
    >;
    expect(hb).toEqual([
      {
        agent_code: REPLAY_HEARTBEAT_CODE,
        kind: "watchdog",
        note: "replayed=0 present=0 more=false",
      },
    ]);
  });

  it("a drain that died after the insert but before the KV delete re-runs without duplicating", async () => {
    await logError(overloadedDb, { message: "once" });
    const [key] = bufferedKeys();
    const saved = kv.store.get(key)!;
    await replay();
    kv.store.set(key, saved); // the delete "never happened"
    const body = (await (await replay()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ replayed: 0, alreadyPresent: 1 });
    expect(rows()).toHaveLength(1);
    expect(bufferedKeys()).toHaveLength(0);
  });

  it("an unparseable buffer entry is discarded, not replayed and not retried forever", async () => {
    kv.store.set(`${BUFFER_ROW_PREFIX}000000000000001:x`, "{not json");
    const body = (await (await replay()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, discarded: 1, replayed: 0 });
    expect(bufferedKeys()).toHaveLength(0);
  });
});

describe("OPE-1664 ask 3 — the buffer is bounded and drops are counted", () => {
  const row = (i: number): ErrorLogRow => ({
    id: `r${i}`,
    timestamp: new Date(Date.parse("2026-11-13T01:00:00Z") + i),
    level: "error",
    message: `m${i}`,
    context: "{}",
  });
  const NOW = Date.parse("2026-11-13T01:30:00Z");

  it(`buffers ${BUFFER_CAP_PER_HOUR} rows in an hour, then drops and counts the rest`, async () => {
    for (let i = 0; i < BUFFER_CAP_PER_HOUR; i++) {
      expect(await bufferFailedErrorLog(kv, row(i), NOW)).toBe("buffered");
    }
    expect(await bufferFailedErrorLog(kv, row(9001), NOW)).toBe("dropped");
    expect(await bufferFailedErrorLog(kv, row(9002), NOW)).toBe("dropped");
    expect(bufferedKeys()).toHaveLength(BUFFER_CAP_PER_HOUR);
    expect(kv.store.get("errlog-buf:drops:2026-11-13T01")).toBe("2");
    // A new hour gets a fresh allowance.
    expect(await bufferFailedErrorLog(kv, row(9003), NOW + 3600_000)).toBe("buffered");
  });

  it("the drain reports recent drops", async () => {
    kv.store.set("errlog-buf:drops:2026-11-13T01", "7");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T02:05:00Z"));
    const body = (await (await replay()).json()) as Record<string, unknown>;
    expect(body.recentDrops).toEqual({ "2026-11-13T01": 7 });
  });

  it("a rate-limited hour counter (KV ~1 write/s per key) still reports the row as buffered", async () => {
    const put = kv.put;
    kv.put = async (k, v, o) => {
      if (k.startsWith("errlog-buf:count:"))
        throw new Error("KV PUT failed: 429 Too Many Requests");
      return put(k, v, o);
    };
    expect(await bufferFailedErrorLog(kv, row(1), NOW)).toBe("buffered");
    expect(bufferedKeys()).toHaveLength(1);
  });

  it("never throws: no KV, or a KV that fails, is reported and swallowed", async () => {
    expect(await bufferFailedErrorLog(null, row(1), NOW)).toBe("no-kv");
    kv.failPut = true;
    expect(await bufferFailedErrorLog(kv, row(1), NOW)).toBe("kv-failed");
    state.kv = kv;
    await expect(logError(overloadedDb, { message: "x" })).resolves.toBeUndefined();
  });
});

describe("markReplayed", () => {
  it("keeps an object context, wraps a non-object one, and survives bad JSON", () => {
    expect(JSON.parse(markReplayed('{"a":1}', 0))).toEqual({
      a: 1,
      replayedFromBuffer: true,
      bufferedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(markReplayed("[1]", 0)).originalContext).toEqual([1]);
    expect(JSON.parse(markReplayed("{oops", 0)).originalContext).toBe("{oops");
    expect(JSON.parse(markReplayed(null, 0)).replayedFromBuffer).toBe(true);
  });
});

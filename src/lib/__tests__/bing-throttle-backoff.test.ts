/**
 * OPE-1026 — Bing throttles with HTTP 400 `17: ERROR!!! ThrottleIP`, not 429.
 *
 * The fixtures here use the response Bing ACTUALLY sent — copied from
 * bing_liveness_log rows 31–37 (2026-09-09 → 09-15). The older reconcile test
 * faked the throttle as `{ status: 429 }`, which is the one shape production
 * never produced, so the early stop it asserted was never exercised live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import {
  BING_THROTTLE_LATCH_KEY,
  BingApiError,
  getCrawlStats,
  getUrlInfo,
  isBingThrottleResponse,
} from "../bing-webmaster";
import { runBingSweep } from "../bing-inspection-sweep";
import { reconcileTimeToIndexFromCrawl } from "../time-to-index-reconcile";

/** The body Bing returned on every throttled call, verbatim in shape. */
const THROTTLE_BODY = { ErrorCode: 17, Message: "ERROR!!! ThrottleIP" };

function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    store,
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  };
  return kv;
}

function stubFetch(respond: () => Response) {
  const fn = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fn);
  return fn;
}

const throttled = () => new Response(JSON.stringify(THROTTLE_BODY), { status: 400 });
const crawlOk = () =>
  new Response(JSON.stringify({ d: [{ Date: "2026-09-14", CrawledPages: 3 }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("isBingThrottleResponse", () => {
  it("recognises the production throttle: 400 + ThrottleIP", () => {
    expect(isBingThrottleResponse(400, "17: ERROR!!! ThrottleIP")).toBe(true);
  });
  it("recognises a plain 429", () => {
    expect(isBingThrottleResponse(429, "Too Many Requests")).toBe(true);
  });
  it("does NOT treat an ordinary 400 as a throttle", () => {
    expect(isBingThrottleResponse(400, "3: InvalidApiKey")).toBe(false);
  });
});

describe("bingFetch throttle latch", () => {
  it("a throttled response throws throttled=true with the real detail and sets the latch", async () => {
    const kv = fakeKv();
    stubFetch(throttled);
    const env = { BING_WEBMASTER_API_KEY: "k", RATE_LIMIT_KV: kv } as never;

    const err = await getCrawlStats(env, { skipCache: true }).catch((e) => e);
    expect(err).toBeInstanceOf(BingApiError);
    expect(err.status).toBe(400);
    expect(err.detail).toBe("17: ERROR!!! ThrottleIP");
    expect(err.throttled).toBe(true);
    expect(kv.store.has(BING_THROTTLE_LATCH_KEY)).toBe(true);
  });

  it("while latched, a normal call sends NO request and fails as throttled", async () => {
    const kv = fakeKv();
    kv.store.set(
      BING_THROTTLE_LATCH_KEY,
      JSON.stringify({
        since: "2026-09-15T06:00:00Z",
        endpoint: "GetUrlInfo",
        detail: "17: ERROR!!! ThrottleIP",
      })
    );
    const fetchFn = stubFetch(crawlOk);
    const env = { BING_WEBMASTER_API_KEY: "k", RATE_LIMIT_KV: kv } as never;

    const err = await getUrlInfo(env, "https://meetmeatthefair.com/blog/x", {
      skipCache: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BingApiError);
    expect(err.throttled).toBe(true);
    expect(err.detail).toMatch(/no request sent/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the re-probe (ignoreThrottleLatch) goes through and clears the latch on success", async () => {
    const kv = fakeKv();
    kv.store.set(
      BING_THROTTLE_LATCH_KEY,
      JSON.stringify({ since: "2026-09-15T06:00:00Z", endpoint: "GetUrlInfo", detail: "x" })
    );
    const fetchFn = stubFetch(crawlOk);
    const env = { BING_WEBMASTER_API_KEY: "k", RATE_LIMIT_KV: kv } as never;

    const rows = await getCrawlStats(env, { skipCache: true, ignoreThrottleLatch: true });
    expect(rows).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(kv.store.has(BING_THROTTLE_LATCH_KEY)).toBe(false);
  });

  it("an ordinary (non-throttle) API error does not set the latch", async () => {
    const kv = fakeKv();
    stubFetch(
      () =>
        new Response(JSON.stringify({ ErrorCode: 3, Message: "InvalidApiKey" }), { status: 400 })
    );
    const env = { BING_WEBMASTER_API_KEY: "k", RATE_LIMIT_KV: kv } as never;

    const err = await getCrawlStats(env, { skipCache: true }).catch((e) => e);
    expect(err.throttled).toBe(false);
    expect(kv.store.has(BING_THROTTLE_LATCH_KEY)).toBe(false);
  });
});

describe("loops stop on the REAL throttle", () => {
  let raw: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    raw = new Database(":memory:");
    raw.exec(`
      CREATE TABLE time_to_index_log (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, target_type TEXT, target_id TEXT,
        indexnow_submitted_at INTEGER NOT NULL, first_crawl_at INTEGER,
        lag_seconds INTEGER, computed_at INTEGER NOT NULL
      );
      CREATE TABLE blog_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE bing_inspection_state (
        url TEXT PRIMARY KEY, is_indexed INTEGER, last_crawled INTEGER,
        crawl_error TEXT, last_checked_at INTEGER
      );
    `);
    db = drizzle(raw, { schema });
  });
  afterEach(() => raw.close());

  it("time-to-index reconcile stops after ONE throttled lookup (400 ThrottleIP, not 429)", async () => {
    const ins = raw.prepare(
      "INSERT INTO time_to_index_log (id, url, indexnow_submitted_at, computed_at) VALUES (?,?,?,?)"
    );
    for (let i = 0; i < 5; i++)
      ins.run(`r${i}`, `https://meetmeatthefair.com/e${i}`, 1000 + i, 1000);

    let calls = 0;
    const res = await reconcileTimeToIndexFromCrawl(
      db as never,
      async () => {
        calls++;
        throw new BingApiError(400, "17: ERROR!!! ThrottleIP");
      },
      { limit: 50 }
    );
    expect(calls).toBe(1);
    expect(res.quotaStopped).toBe(true);
    expect(res.errors).toBe(0);
  });

  it("the Bing inspection sweep stops after ONE throttled response and reports throttled", async () => {
    const ins = raw.prepare("INSERT INTO blog_posts (id, slug, status) VALUES (?,?,'PUBLISHED')");
    for (let i = 0; i < 10; i++) ins.run(`b${i}`, `post-${i}`);
    const fetchFn = stubFetch(throttled);

    const res = await runBingSweep(db as never, { BING_WEBMASTER_API_KEY: "k" } as never, {
      batchSize: 10,
    });
    // Positive landmark: 10 candidates were picked, so "1 call" is a stop, not an empty batch.
    expect(res.skipped).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(res.throttled).toBe(true);
    expect(res.inspected).toBe(0);
  });

  it("the inspection sweep still continues past a NON-throttle failure", async () => {
    const ins = raw.prepare("INSERT INTO blog_posts (id, slug, status) VALUES (?,?,'PUBLISHED')");
    for (let i = 0; i < 3; i++) ins.run(`b${i}`, `post-${i}`);
    const fetchFn = stubFetch(() => new Response("boom", { status: 500 }));

    const res = await runBingSweep(db as never, { BING_WEBMASTER_API_KEY: "k" } as never, {
      batchSize: 10,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(res.skipped).toBe(3);
    expect(res.throttled).toBe(false);
  });
});

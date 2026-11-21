/**
 * OPE-1677 — kvReadThroughSwr: a stale hit is served at once and refreshed
 * after the response, at most once; concurrent misses share one build.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReadThroughKv } from "../kv-read-through";
import {
  kvReadThroughSwr,
  swrIsRefreshing,
  swrRefreshMarkerKey,
  SWR_DEFAULT_STALE_SECONDS,
} from "../kv-swr";

function memoryKv() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl?: number }> = [];
  const kv: ReadThroughKv = {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key, value, opts) {
      puts.push({ key, ttl: opts?.expirationTtl });
      store.set(key, value);
    },
  };
  return { kv, store, puts };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const T0 = 1_800_000_000_000;
const env = (v: unknown, softExpiryMs: number) => JSON.stringify({ __swr: 1, s: softExpiryMs, v });

describe("fresh and stale hits", () => {
  it("a FRESH hit is served with no build and no refresh", async () => {
    const { kv, store } = memoryKv();
    store.set("k", env(["fresh"], T0 + 60_000));
    const loader = vi.fn(async () => ["new"]);
    const waitUntil = vi.fn();
    const out = await kvReadThroughSwr(kv, "k", 300, loader, { now: () => T0, waitUntil });
    expect(out).toEqual(["fresh"]);
    expect(loader).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("a STALE hit is served BEFORE the build finishes, and exactly one refresh is scheduled", async () => {
    const { kv, store } = memoryKv();
    store.set("k", env(["stale"], T0 - 1));
    const build = deferred<string[]>();
    const loader = vi.fn(() => build.promise);
    const scheduled: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => void scheduled.push(p));

    // The build has NOT resolved, yet the page has its answer.
    const out = await kvReadThroughSwr(kv, "k", 300, loader, { now: () => T0, waitUntil });
    expect(out).toEqual(["stale"]);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(swrIsRefreshing("k")).toBe(true);

    build.resolve(["new"]);
    await Promise.all(scheduled);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(swrIsRefreshing("k")).toBe(false);
    const written = JSON.parse(store.get("k")!);
    expect(written).toEqual({ __swr: 1, s: T0 + 300_000, v: ["new"] });

    // …and the next request is a fresh hit on the new value.
    const next = await kvReadThroughSwr(kv, "k", 300, loader, { now: () => T0 + 1, waitUntil });
    expect(next).toEqual(["new"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("TWENTY concurrent stale hits schedule ONE refresh and run ONE build", async () => {
    const { kv, store } = memoryKv();
    store.set("k20", env("stale", T0 - 1));
    const build = deferred<string>();
    const loader = vi.fn(() => build.promise);
    const scheduled: Promise<unknown>[] = [];
    const waitUntil = vi.fn((p: Promise<unknown>) => void scheduled.push(p));

    const outs = await Promise.all(
      Array.from({ length: 20 }, () =>
        kvReadThroughSwr(kv, "k20", 300, loader, { now: () => T0, waitUntil })
      )
    );
    expect(outs).toEqual(Array(20).fill("stale"));
    build.resolve("new");
    await Promise.all(scheduled);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("another isolate's refresh marker suppresses this isolate's build", async () => {
    const { kv, store } = memoryKv();
    store.set("km", env("stale", T0 - 1));
    store.set(swrRefreshMarkerKey("km"), JSON.stringify(T0 - 5));
    const loader = vi.fn(async () => "new");
    const scheduled: Promise<unknown>[] = [];
    await kvReadThroughSwr(kv, "km", 300, loader, {
      now: () => T0,
      waitUntil: (p) => void scheduled.push(p),
    });
    await Promise.all(scheduled);
    expect(loader).not.toHaveBeenCalled();
  });

  it("the refresh writes its marker with KV's minimum TTL", async () => {
    const { kv, store, puts } = memoryKv();
    store.set("kt", env("stale", T0 - 1));
    const scheduled: Promise<unknown>[] = [];
    await kvReadThroughSwr(kv, "kt", 300, async () => "new", {
      now: () => T0,
      waitUntil: (p) => void scheduled.push(p),
    });
    await Promise.all(scheduled);
    expect(puts).toEqual([
      { key: swrRefreshMarkerKey("kt"), ttl: 60 },
      { key: "kt", ttl: 300 + SWR_DEFAULT_STALE_SECONDS },
    ]);
  });

  it("a plain value written by kvReadThrough before the deploy is served, then refreshed into an envelope", async () => {
    const { kv, store } = memoryKv();
    store.set("legacy", JSON.stringify({ ids: ["a"], depth: 3 }));
    const scheduled: Promise<unknown>[] = [];
    const out = await kvReadThroughSwr(kv, "legacy", 300, async () => ({ ids: ["b"], depth: 4 }), {
      now: () => T0,
      waitUntil: (p) => void scheduled.push(p),
    });
    expect(out).toEqual({ ids: ["a"], depth: 3 });
    await Promise.all(scheduled);
    expect(JSON.parse(store.get("legacy")!).v).toEqual({ ids: ["b"], depth: 4 });
  });

  it("a failed background refresh is swallowed and the stale value keeps serving", async () => {
    const { kv, store } = memoryKv();
    store.set("kf", env("stale", T0 - 1));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduled: Promise<unknown>[] = [];
    const out = await kvReadThroughSwr(
      kv,
      "kf",
      300,
      async () => {
        throw new Error("D1 overloaded");
      },
      { now: () => T0, waitUntil: (p) => void scheduled.push(p) }
    );
    expect(out).toBe("stale");
    await expect(Promise.all(scheduled)).resolves.toBeDefined();
    expect(JSON.parse(store.get("kf")!).v).toBe("stale");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("hard misses", () => {
  it("TWENTY concurrent misses in one isolate share ONE build", async () => {
    const { kv } = memoryKv();
    const build = deferred<number[]>();
    const loader = vi.fn(() => build.promise);
    const all = Promise.all(
      Array.from({ length: 20 }, () =>
        kvReadThroughSwr(kv, "miss20", 300, loader, { now: () => T0 })
      )
    );
    build.resolve([1, 2, 3]);
    expect(await all).toEqual(Array(20).fill([1, 2, 3]));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a hard miss while a refresh is running gets the VALUE, never the refresh's undefined", async () => {
    const { kv, store } = memoryKv();
    store.set("kx", env("stale", T0 - 1));
    const refreshBuild = deferred<string>();
    const scheduled: Promise<unknown>[] = [];
    await kvReadThroughSwr(kv, "kx", 300, () => refreshBuild.promise, {
      now: () => T0,
      waitUntil: (p) => void scheduled.push(p),
    });
    expect(swrIsRefreshing("kx")).toBe(true);
    store.delete("kx"); // the hard TTL lapses mid-refresh
    const out = await kvReadThroughSwr(kv, "kx", 300, async () => "built-inline", {
      now: () => T0,
    });
    expect(out).toBe("built-inline");
    refreshBuild.resolve("refreshed");
    await Promise.all(scheduled);
  });

  it("a loader error on the inline path propagates (as kvReadThrough's does)", async () => {
    const { kv } = memoryKv();
    await expect(
      kvReadThroughSwr(kv, "kerr", 300, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  it("no binding → loader result, nothing cached", async () => {
    const loader = vi.fn(async () => 42);
    expect(await kvReadThroughSwr(null, "k", 300, loader)).toBe(42);
    expect(await kvReadThroughSwr(undefined, "k", 300, loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("fails open when KV get and put throw", async () => {
    const broken: ReadThroughKv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    expect(await kvReadThroughSwr(broken, "k", 300, async () => "fresh")).toBe("fresh");
  });
});

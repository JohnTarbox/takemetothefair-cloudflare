/**
 * OPE-1677 — stale-while-revalidate over KV, for the event listing caches.
 *
 * `kvReadThrough` (OPE-1573) builds a missing value on the request that misses.
 * For the event listing sets that build is the expensive part — the `/events`
 * upcoming set is ~646 events and a listing select plus ~26 vendor/event-day
 * batches; the first render after the 2026-11-17 19:59Z deploy took 18.4 s — and
 * with no single-flight, every request that misses while a build is running
 * starts its own: a burst at expiry multiplies exactly the D1 load the cache
 * exists to remove (the OPE-1573 / OPE-1662 overload shape).
 *
 * This sibling keeps `kvReadThrough`'s signature and failure contract, and
 * changes WHEN the build runs:
 *
 *   - The value is stored in an envelope carrying a SOFT expiry (`ttlSeconds`
 *     from the write). KV keeps it for `ttlSeconds + staleSeconds`.
 *   - FRESH hit → served.
 *   - STALE hit (past soft expiry, or a plain pre-envelope value) → served AT
 *     ONCE, and one refresh is scheduled after the response (`ctx.waitUntil`).
 *     No visitor waits on a build.
 *   - Refreshes are bounded: one per key per isolate (an in-flight map), and
 *     one per key per ~60 s across isolates (a short KV marker). The marker
 *     bounds a burst; it is not a lock — KV is eventually consistent, so two
 *     colos can both refresh, which is two builds instead of twenty.
 *   - HARD miss (nothing cached) → built inline, as before, but concurrent
 *     misses in the same isolate share ONE build.
 *
 * Failure contract, unchanged from kvReadThrough: no binding, a KV read error,
 * or a KV write error all fail open. A loader error on the inline (hard-miss)
 * path propagates. A loader error during a background refresh is swallowed —
 * the stale value keeps serving until its hard TTL and the next stale hit after
 * the marker lapses tries again.
 *
 * `/blog`, `/vendors` and the ga4/bing caches stay on kvReadThrough: their
 * builds are cheap, and serving stale there was not asked for.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ReadThroughKv } from "@/lib/kv-read-through";

/** KV rejects an `expirationTtl` under 60s. */
const KV_MIN_TTL_SECONDS = 60;

/**
 * How long past soft expiry a value may still be served while it refreshes.
 * Under traffic a stale value is served only until the refresh lands (one
 * build), so this bounds the QUIET-key case: the first visitor after an hour
 * of silence is served the last build, and the one after them a fresh one.
 */
export const SWR_DEFAULT_STALE_SECONDS = 3600;

/** The cross-isolate refresh marker's lifetime (KV's minimum TTL). */
export const SWR_REFRESH_MARKER_SECONDS = KV_MIN_TTL_SECONDS;

interface Envelope<T> {
  __swr: 1;
  /** Soft expiry, epoch ms. */
  s: number;
  v: T;
}

function asEnvelope<T>(x: unknown): Envelope<T> | null {
  if (
    x !== null &&
    typeof x === "object" &&
    (x as Envelope<T>).__swr === 1 &&
    typeof (x as Envelope<T>).s === "number" &&
    "v" in (x as object)
  ) {
    return x as Envelope<T>;
  }
  return null;
}

export const swrRefreshMarkerKey = (key: string) => `${key}:refreshing`;

export interface SwrOptions {
  staleSeconds?: number;
  /** Run work after the response. Defaults to the request's `ctx.waitUntil`. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Clock, epoch ms (tests). */
  now?: () => number;
}

/**
 * Per-isolate single-flight, key → the work in progress. TWO maps on purpose:
 * a hard-miss build resolves to the value and its waiters return it; a
 * background refresh resolves to nothing. Sharing one map would let a hard
 * miss that lands while a refresh is running join the refresh and hand the
 * page `undefined`.
 */
const building = new Map<string, Promise<unknown>>();
const refreshing = new Map<string, Promise<unknown>>();

function singleFlight<T>(
  map: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const running = map.get(key);
  if (running) return running as Promise<T>;
  const p = work().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

/** Test hook: is a background refresh for `key` in flight in this isolate? */
export function swrIsRefreshing(key: string): boolean {
  return refreshing.has(key);
}

function defaultWaitUntil(p: Promise<unknown>) {
  try {
    getCloudflareContext().ctx.waitUntil(p);
  } catch {
    // No request context (tests, local build): the promise still runs.
  }
}

async function writeEnvelope<T>(
  kv: ReadThroughKv,
  key: string,
  value: T,
  ttlSeconds: number,
  staleSeconds: number,
  nowMs: number
) {
  const env: Envelope<T> = { __swr: 1, s: nowMs + ttlSeconds * 1000, v: value };
  try {
    await kv.put(key, JSON.stringify(env), {
      expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.floor(ttlSeconds + staleSeconds)),
    });
  } catch {
    // Fail open: the next request simply reloads.
  }
}

export async function kvReadThroughSwr<T>(
  kv: ReadThroughKv | null | undefined,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  opts: SwrOptions = {}
): Promise<T> {
  if (!kv) return loader();
  const now = opts.now ?? Date.now;
  const staleSeconds = opts.staleSeconds ?? SWR_DEFAULT_STALE_SECONDS;

  let hit: unknown = null;
  try {
    hit = await kv.get(key, "json");
  } catch {
    // Fail open: a KV outage must not become a page outage.
  }

  if (hit !== null && hit !== undefined) {
    const env = asEnvelope<T>(hit);
    // A plain value is one written by kvReadThrough before this deploy: same
    // payload shape, no soft expiry — serve it and treat it as stale.
    const value = env ? env.v : (hit as T);
    if (!env || env.s <= now()) {
      scheduleRefresh(
        kv,
        key,
        ttlSeconds,
        staleSeconds,
        loader,
        opts.waitUntil ?? defaultWaitUntil,
        now
      );
    }
    return value;
  }

  return singleFlight(building, key, async () => {
    const fresh = await loader();
    await writeEnvelope(kv, key, fresh, ttlSeconds, staleSeconds, now());
    return fresh;
  });
}

function scheduleRefresh<T>(
  kv: ReadThroughKv,
  key: string,
  ttlSeconds: number,
  staleSeconds: number,
  loader: () => Promise<T>,
  waitUntil: (p: Promise<unknown>) => void,
  now: () => number
) {
  if (refreshing.has(key)) return; // this isolate is already refreshing it
  const work = singleFlight(refreshing, key, async () => {
    const marker = swrRefreshMarkerKey(key);
    try {
      if ((await kv.get(marker, "json")) !== null) return; // another isolate has it
      await kv.put(marker, JSON.stringify(now()), { expirationTtl: SWR_REFRESH_MARKER_SECONDS });
    } catch {
      // Marker unavailable: refresh anyway — the in-flight map still bounds
      // this isolate, and a failed marker must not wedge the value stale.
    }
    const fresh = await loader();
    await writeEnvelope(kv, key, fresh, ttlSeconds, staleSeconds, now());
  }).catch((err) => {
    console.warn(`[kv-swr] background refresh failed for ${key}:`, err);
  });
  waitUntil(work);
}

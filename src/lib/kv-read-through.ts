/**
 * OPE-1573 — a small KV read-through cache for reads whose result does not
 * depend on the request.
 *
 * Why KV and not `unstable_cache`: every public listing page calls `auth()`
 * and is `force-dynamic`, and the OpenNext incremental cache holds only the
 * build-time entries (see open-next.config.ts). KV is the cache this app
 * already runs in production (ga4.ts, bing-webmaster.ts), on the
 * `RATE_LIMIT_KV` binding.
 *
 * Fails OPEN in both directions: no binding (local build / tests), a KV read
 * error, a corrupt value, or a KV write error all fall through to the loader,
 * so the cache can make a page cheaper but never makes it fail. A loader error
 * is NOT swallowed — it propagates exactly as it did before the cache.
 */
export interface ReadThroughKv {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** KV rejects an `expirationTtl` under 60s. */
const KV_MIN_TTL_SECONDS = 60;

export async function kvReadThrough<T>(
  kv: ReadThroughKv | null | undefined,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  if (kv) {
    try {
      const hit = await kv.get(key, "json");
      if (hit !== null && hit !== undefined) return hit as T;
    } catch {
      // Fail open: a KV outage must not become a page outage.
    }
  }

  const fresh = await loader();

  if (kv) {
    try {
      await kv.put(key, JSON.stringify(fresh), {
        expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
      });
    } catch {
      // Fail open: the next request simply reloads.
    }
  }
  return fresh;
}

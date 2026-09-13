import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The hard cap: this many hits per key per window. */
export const BURST_LIMIT = 5;
/** The window, in seconds. Also the ceiling on a burst refusal's Retry-After. */
export const BURST_WINDOW_SECONDS = 60;

export interface BurstLimiter {
  limit(options: { key: string }): Promise<{ success: boolean; retryAfterSeconds?: number }>;
}

/** What `BurstCounter.hit()` returns over RPC (mcp-server/src/burst-counter.ts). */
interface BurstCounterStub {
  hit(
    limit: number,
    periodSeconds: number
  ): Promise<{ success: boolean; count: number; retryAfterSeconds: number }>;
}

/** The slice of `DurableObjectNamespace` this module uses. */
interface BurstCounterNamespace {
  idFromName(name: string): unknown;
  get(id: never): unknown;
}

/**
 * OPE-951 — the HARD burst cap: a Durable Object per key.
 *
 * ## Why not the Workers Rate Limiting binding
 *
 * OPE-904 shipped this layer on the `BURST_LIMITER` ratelimit binding. In
 * production it returned `success: true` for every call — 7+ requests per colo
 * inside one 60 s window on a 5/60 s budget, none refused — while the same
 * binding refused at call 7 in an isolated Worker. Cloudflare documents it as
 * "permissive, eventually consistent, and intentionally designed to not be used
 * as an accurate accounting system". The eight policies this layer guards need
 * a cap that holds, so the binding is gone.
 *
 * A Durable Object named by the key receives every hit for that key and
 * processes them one at a time, reading and writing synchronous storage with
 * no await between — so no two hits can both read the old count.
 *
 * The class lives in the MCP Worker (`BurstCounter`); this app binds it
 * cross-script as `BURST_COUNTER`. Two callers share it with distinct key
 * namespaces: the eight `BURST_POLICIES` and the internal-key refusal log in
 * `api-auth.ts`.
 *
 * Returns null when there is no binding (unit tests, `next dev`). What a caller
 * does with null is its own stated posture — see both call sites.
 */
export function getBurstLimiter(): BurstLimiter | null {
  let ns: BurstCounterNamespace | undefined;
  try {
    const { env } = getCloudflareContext();
    ns = (env as { BURST_COUNTER?: BurstCounterNamespace }).BURST_COUNTER;
  } catch {
    return null;
  }
  if (!ns) return null;
  const namespace = ns;
  return {
    async limit({ key }) {
      // The one cast here: a cross-script Durable Object namespace is typed
      // without its class (wrangler types cannot see into the MCP Worker), so
      // the RPC method is declared locally above, matching BurstCounter.hit.
      const stub = namespace.get(namespace.idFromName(key) as never) as BurstCounterStub;
      const r = await stub.hit(BURST_LIMIT, BURST_WINDOW_SECONDS);
      return { success: r.success, retryAfterSeconds: r.retryAfterSeconds };
    },
  };
}

/**
 * In-memory stand-in for the BurstCounter Durable Object namespace (OPE-951).
 * Uses the REAL window arithmetic (`decideBurstHit`), so a test exercises the
 * same counting the Worker does — only storage and the RPC hop are faked.
 */
import { decideBurstHit, type BurstWindowState } from "../../src/burst-counter.js";
import type { BurstCounterNamespace } from "../../src/oauth/authorize-throttle.js";

export function makeFakeBurstCounter(now: () => number = Date.now) {
  const windows = new Map<string, BurstWindowState>();
  const hits: Array<{ key: string; limit: number; periodSeconds: number }> = [];
  const ns: BurstCounterNamespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const key = id as unknown as string;
      return {
        hit: async (limit: number, periodSeconds: number) => {
          hits.push({ key, limit, periodSeconds });
          const { next, result } = decideBurstHit(windows.get(key), now(), limit, periodSeconds);
          windows.set(key, next);
          return result;
        },
      };
    },
  };
  return { ns, windows, hits };
}

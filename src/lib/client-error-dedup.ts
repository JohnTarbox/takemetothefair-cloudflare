/**
 * OPE-25 — tiny in-memory deduper for the client-error reporter.
 *
 * Pure + side-effect-free (no DOM, no timers), so it's unit-testable. Suppresses
 * a key that was reported again within `windowMs`. The timestamp is recorded
 * only on a NON-duplicate report (not refreshed on each suppressed hit), so a
 * sustained identical error still surfaces at most once per window rather than
 * being muted forever.
 */
export interface Deduper {
  /** True if `key` was reported within `windowMs` of its last report (a
   *  duplicate to skip). Records `now` as the last-report time when NOT a
   *  duplicate. */
  isDuplicate(key: string, now: number): boolean;
}

export function createDeduper(windowMs: number): Deduper {
  const lastSeen = new Map<string, number>();
  return {
    isDuplicate(key: string, now: number): boolean {
      // Prune expired entries so the map can't grow unbounded.
      for (const [k, t] of lastSeen) {
        if (now - t > windowMs) lastSeen.delete(k);
      }
      const last = lastSeen.get(key);
      if (last !== undefined && now - last <= windowMs) return true;
      lastSeen.set(key, now);
      return false;
    },
  };
}

/**
 * OPE-1573 — run an async mapper over `items` with at most `limit` calls in
 * flight, returning results in input order (like `Promise.all(items.map(fn))`).
 *
 * Why this exists: a D1 database is single-threaded and queues concurrent
 * requests; when the queue backs up it fails EVERY waiting caller with
 * "D1 DB is overloaded. Requests queued for too long" — including unrelated
 * public page renders. A `Promise.all` over ~110 heartbeat probes put ~110
 * requests in that queue in the same instant on every /admin/analytics
 * Overview render and every stale-red scan. Capping in-flight work spreads
 * the same queries over time (Cloudflare's documented remedy) so other
 * requests interleave instead of waiting behind the whole burst.
 *
 * Rejects with the first error, like Promise.all; workers stop picking up new
 * items once one has failed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

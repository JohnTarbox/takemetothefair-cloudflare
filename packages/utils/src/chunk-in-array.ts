/**
 * OPE-241 — the shared remedy for D1's 100-bound-parameter cap.
 *
 * The ceiling
 * -----------
 * D1/SQLite refuses a query with more than 100 bound parameters:
 *
 *     IN (…101 bound params…) → 7500 "too many SQL variables at offset 260: SQLITE_ERROR"
 *
 * So every `inArray(col, xs)` whose `xs.length` grows with row count is a
 * latent 500 that fires the day the table crosses 100 rows. That is not
 * hypothetical: `blog_posts` crossed 100 in early June 2026 and `/admin/blog`
 * threw in prod for weeks before anyone noticed (OPE-79), and `error_logs`
 * still show "too many SQL variables" from the blog-rebuild path.
 *
 * Why 90 and not 100
 * ------------------
 * The cap counts EVERY bound parameter in the statement, not just the IN list
 * — the surrounding WHERE clause spends some too. 90 leaves ~10 for the rest
 * of the query, which matches the value `CONTENT_LINK_INARRAY_CHUNK` already
 * used before this helper existed. If a query binds more than ~10 params
 * outside its IN list, pass a smaller size explicitly.
 *
 * Note this is a DIFFERENT D1 ceiling from the 100-*column* result-row cap
 * guarded by scripts/check-d1-100col-joins.ts. Both are 100; they are
 * unrelated limits and a query can hit either.
 */

/** D1/SQLite's hard ceiling on bound parameters in a single statement. */
export const D1_MAX_BIND_PARAMS = 100;

/**
 * Default IN-list batch size. Deliberately below D1_MAX_BIND_PARAMS to leave
 * headroom for the parameters the rest of the query binds.
 */
export const D1_SAFE_IN_CHUNK = 90;

/**
 * Split an array into batches small enough to pass to `inArray()` safely.
 *
 * Returns an empty array for an empty input, so `for (const batch of
 * chunkIds(xs))` is a no-op rather than issuing a pointless `IN ()` query.
 *
 * @param items the bind list (usually ids)
 * @param size  max items per batch; defaults to D1_SAFE_IN_CHUNK (90)
 *
 * @example
 *   for (const batch of chunkIds(eventIds)) {
 *     const rows = await db.select().from(eventVendors)
 *       .where(inArray(eventVendors.eventId, batch));
 *     rows.forEach(r => byEvent.get(r.eventId)!.push(r));
 *   }
 */
export function chunkIds<T>(items: readonly T[], size: number = D1_SAFE_IN_CHUNK): T[][] {
  if (size < 1) throw new RangeError(`chunkIds: size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run `fetch` once per batch and flatten the results — the one-line swap for
 * an unbounded `inArray()` read.
 *
 * Batches run SEQUENTIALLY on purpose: these fan-outs are usually admin//sweep
 * paths where a burst of parallel D1 reads is worse than a few extra ms, and
 * Workers cap concurrent subrequests. If a caller genuinely needs parallelism,
 * use `chunkIds()` directly and compose its batches however it likes.
 *
 * Only for READS that return rows to merge. A write fan-out wants its own
 * error handling per batch, so it should use `chunkIds()` directly.
 *
 * @example
 *   const rows = await chunkedInArray(eventIds, (batch) =>
 *     db.select().from(eventVendors).where(inArray(eventVendors.eventId, batch))
 *   );
 */
export async function chunkedInArray<T, R>(
  items: readonly T[],
  fetch: (batch: T[]) => Promise<R[]>,
  size: number = D1_SAFE_IN_CHUNK
): Promise<R[]> {
  const out: R[] = [];
  for (const batch of chunkIds(items, size)) {
    out.push(...(await fetch(batch)));
  }
  return out;
}

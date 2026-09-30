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

/**
 * OPE-1185 — rows per multi-row INSERT that keep the statement under the cap.
 *
 * Every row binds `paramsPerRow` parameters, INCLUDING the ones the ORM fills
 * itself: Drizzle binds a column's `$defaultFn` value (a generated `id`, a
 * `created_at`) exactly like a caller-supplied one. That is how
 * `import_bing_backlinks` shipped at 30 rows on the belief of "3 columns per
 * row" and bound 30 × 5 = 150 — the comment counted the values it wrote, not
 * the values it sent. So measure `paramsPerRow` from the built statement
 * (`insert(...).values([oneRow]).toSQL().params.length`), don't count by eye.
 *
 * `fixedParams` = parameters the statement binds once regardless of row count
 * (e.g. an ON CONFLICT ... SET with a literal). Always ≥ 1 row.
 */
export function rowsPerInsert(paramsPerRow: number, fixedParams = 0): number {
  if (!Number.isFinite(paramsPerRow) || paramsPerRow <= 0) return 1;
  return Math.max(1, Math.floor((D1_MAX_BIND_PARAMS - fixedParams) / paramsPerRow));
}

/**
 * OPE-1185 — run a multi-row INSERT in chunks that fit D1's parameter cap.
 *
 * `build(chunk)` returns the ORM statement for those rows (a Drizzle insert,
 * with whatever ON CONFLICT it needs). The parameters one row binds are
 * MEASURED from `build([firstRow]).toSQL()`, so ORM-supplied defaults are
 * counted and a later schema change re-sizes the chunks by itself. Returns the
 * number of statements executed. Rows are written in order; not atomic across
 * chunks (each chunk is its own statement), same as a hand-rolled loop.
 */
export async function runChunkedInsert<R>(
  rows: readonly R[],
  build: (chunk: R[]) => { toSQL(): { params: unknown[] } } & PromiseLike<unknown>
): Promise<number> {
  if (rows.length === 0) return 0;
  const perRow = build(rows.slice(0, 1) as R[]).toSQL().params.length;
  const size = rowsPerInsert(perRow);
  let statements = 0;
  for (let i = 0; i < rows.length; i += size) {
    await build(rows.slice(i, i + size) as R[]);
    statements++;
  }
  return statements;
}

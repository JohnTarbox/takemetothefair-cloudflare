/**
 * Build AND execute D1 statements one chunk at a time.
 *
 * ── Why this exists (OPE-641, regression of OPE-489) ─────────────────────
 *
 * The GSC metrics sync did this:
 *
 *     const stmts = rows.map((r) => db.insert(...).values(...).onConflictDoUpdate(...));
 *     await runBatched(db, stmts);   // chunks the EXECUTION, 50 at a time
 *
 * `runBatched` looks like the bounded version and is not. It slices an array
 * that is **already fully materialized**, so peak memory is spent before the
 * first `batch()` ever runs. Chunking downstream of a `.map()` bounds how many
 * statements execute together; it does nothing about how many EXIST.
 *
 * The numbers, measured on prod 2026-08-30: `gsc_search_metrics` takes
 * 3,000–5,000 rows per day and the incremental window is `[today-7, today-3]`,
 * so one ordinary daily run built **15,000–25,000 Drizzle statement objects**
 * at once. Each carries its values, its conflict target and a SQL AST — far
 * heavier than the plain row it came from. That is what crossed the Worker's
 * 128 MB isolate ceiling.
 *
 * The two healthy sweeps already did it correctly — `photo-coverage/scan.ts` and
 * `photo-effectiveness/load.ts` both build their statements INSIDE a
 * `chunkIds()` loop. That, not the gate, is why 3 of 4 sweeps went clean after
 * OPE-489 and this one did not: the right pattern already existed in the repo
 * and this endpoint was the one that mapped everything up front.
 *
 * OPE-489's concurrency gate (`withMainAppSlot`, cap 2) attacked simultaneity
 * and genuinely helped — four sweeps died at the identical second before it,
 * and three of the four have been clean since. It could not help here, because
 * this sweep is heavy enough on its own.
 *
 * ── What the failure actually cost ───────────────────────────────────────
 *
 * Not a skipped run — SILENT PARTIAL DATA. On 2026-08-27 the table holds 239
 * rows against a ~4,000/day baseline: the isolate died mid-way through the
 * chunked writes, leaving the day looking present. GA4 and Bing stopped at
 * 08-25 entirely, because they are sequenced AFTER the GSC block and never got
 * to run. A monitor asking "is there data for that date" would have said yes.
 *
 * ── The invariant ────────────────────────────────────────────────────────
 *
 * At most `chunkSize` statements are alive at any moment: each chunk is built,
 * executed and dropped before the next is constructed. Memory is then a
 * function of `chunkSize`, not of the result-set size, so the endpoint stops
 * caring how big the window is.
 *
 * Do NOT "simplify" this back into `rows.map(...)` followed by a chunked
 * execute. That is the exact shape it replaces, and it reads as correct.
 */

import { chunkIds } from "@takemetothefair/utils";

/**
 * Minimal shape of the Drizzle D1 handle this needs — keeps it testable with a
 * plain object and no D1 binding.
 *
 * `statements: never` rather than `unknown[]` on purpose: Drizzle types
 * `batch` as taking a NON-EMPTY tuple (`Readonly<[U, ...U[]]>`), which an
 * `unknown[]` is not assignable to, so the concrete `DrizzleD1Database` would
 * not satisfy a `unknown[]` signature. A `never` parameter accepts any
 * argument type by contravariance, which is exactly the "I only need SOME
 * batch method" contract here. The single cast lives at the one call below,
 * the same way the code this replaces did it.
 */
interface BatchCapable {
  batch(statements: never): Promise<unknown>;
}

/**
 * Map `rows` to statements and execute them, never holding more than
 * `chunkSize` statements at once. Returns the number of statements executed.
 *
 * `chunkSize` defaults to 50, matching the existing `runBatched` default and
 * staying well inside D1's own per-batch limits.
 */
export async function upsertInChunks<T, S>(
  db: BatchCapable,
  rows: readonly T[],
  toStatement: (row: T) => S,
  chunkSize = 50
): Promise<number> {
  let executed = 0;
  // `chunkIds` is the same primitive the two healthy sweeps use
  // (photo-coverage/scan.ts:279, photo-effectiveness/load.ts:102) — this is
  // deliberately their pattern generalised, not a second one invented beside it.
  for (const slice of chunkIds(rows, chunkSize)) {
    // Build the statements for THIS chunk only. They go out of scope on the
    // next iteration, so the peak is one chunk rather than the whole set.
    const statements = slice.map(toStatement);
    if (statements.length === 0) continue;
    await db.batch(statements as unknown as never);
    executed += statements.length;
  }
  return executed;
}

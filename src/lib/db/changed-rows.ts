/**
 * Rows changed by an awaited Drizzle UPDATE/DELETE, across drivers.
 *
 * D1 returns `{ meta: { changes } }`; better-sqlite3 (the test driver) returns
 * `{ changes }`. An unrecognised shape reads as 0 so a guarded write that
 * cannot prove it landed is treated as not having landed.
 */
export function changedRows(result: unknown): number {
  const r = result as { meta?: { changes?: number }; changes?: number } | null | undefined;
  return r?.meta?.changes ?? r?.changes ?? 0;
}

// OPE-1393 (CLB6) — an enrichment auto-fill only lands if the column still
// holds the value the job READ.
//
// Every enrichment dispatcher reads the row, then spends seconds (sometimes a
// Browser-Rendering escalation) fetching the entity's site, then wrote its
// fills with `WHERE id = ?` alone. An operator who typed a phone/email/
// description into that column during the fetch was silently overwritten by
// the scrape — the "fill-empty-only" rule was checked against a stale read.
//
// Each column is written in its own compare-and-swap UPDATE
// (`WHERE id = ? AND col IS <value read>`; for a null read that is exactly
// `AND col IS NULL`), so one column an operator touched does not block the
// other fills, and the caller learns which columns actually landed — only those
// may be marked auto_merged / logged as applied.
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "../db.js";

export interface GuardedFill {
  /** The proposal's field name (what the caller reports as applied). */
  field: string;
  /** The Drizzle property key of the column to write (e.g. `contactPhone`). */
  key: string;
  value: string;
  /** What the job read from this column before the fetch. */
  readValue: string | null;
}

/** The predicate `col IS <read>` — null-safe equality in SQLite. */
export function unchangedSince(column: SQLiteColumn, readValue: string | null): SQL {
  return readValue === null ? sql`${column} IS NULL` : sql`${column} IS ${readValue}`;
}

/**
 * Write each fill only where the column is unchanged since the read. Returns
 * the `field`s that actually landed, in input order.
 */
export async function writeGuardedFills(
  db: Db,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  id: string,
  fills: GuardedFill[]
): Promise<string[]> {
  const landed: string[] = [];
  for (const f of fills) {
    const column = (table as unknown as Record<string, SQLiteColumn | undefined>)[f.key];
    if (!column) throw new Error(`writeGuardedFills: no column "${f.key}"`);
    const rows = await db
      .update(table)
      .set({ [f.key]: f.value } as never)
      .where(and(eq(idColumn, id), unchangedSince(column, f.readValue)))
      .returning({ id: idColumn });
    if ((rows as unknown[]).length > 0) landed.push(f.field);
  }
  return landed;
}

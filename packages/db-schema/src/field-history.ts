/**
 * OPE-1651 — field-level edit history for events, vendors, venues and promoters.
 *
 * Before this, an overwritten value was simply gone: `update_event` replaced the
 * description of `downeast-fair` on 2026-11-15 and its own response warned that
 * the response was "the only record". `admin_actions` records lifecycle moves,
 * never field edits, so nothing could say what a bad value replaced or which
 * writer wrote it (the OPE-505 `ingestion_method` / `series_id` investigation had
 * to rest on response echoes).
 *
 * One module, imported by BOTH deploy artifacts (the Next.js app and the MCP
 * Worker cannot import each other's code), so every write path runs the same
 * diff. A helper duplicated in two trees is how a fix lands in one of two
 * parallel paths.
 *
 * Usage, at a write site that already holds the row it is about to change:
 *
 *   const rows = buildFieldHistoryRows({ table: events, entityType: "event",
 *     entityId: event.id, before: event, patch: updates, actor, source });
 *   await db.batch([db.update(events).set(updates)..., ...fieldHistoryInserts(db, rows)]);
 *
 * Riding in the same batch as the UPDATE keeps the edit and its record atomic.
 */
import { eq, getTableColumns, is, SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./index";

type Db = DrizzleD1Database<typeof schema>;

export type FieldHistoryEntityType = "event" | "vendor" | "venue" | "promoter";

export type FieldHistoryRow = typeof schema.entityFieldHistory.$inferInsert;

/**
 * Bookkeeping columns every write touches. A row for them would bury the real
 * edits — `updated_at` changes on every save by construction.
 */
const ALWAYS_IGNORED = new Set(["updatedAt", "createdAt"]);

/** `system:<name>` — the actor for a cron or pipeline write with no user. */
export function systemActor(name: string): string {
  return `system:${name}`;
}

/**
 * The text form a value is stored and compared in.
 *
 * - null / undefined → null (both mean "no value"; they never differ).
 * - Date → ISO-8601. Timestamp columns are seconds in D1, so a Date and the
 *   same instant re-read compare equal at second precision.
 * - boolean → "true" / "false"; a 0/1 number written to a boolean column is
 *   coerced to match (see `normalizeForColumn`).
 * - object / array → JSON.
 * - everything else → String(v).
 *
 * Exported for the tests and for the read tool's documentation; callers do not
 * need it.
 */
export function normalizeFieldValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isNaN(t)) return null;
    // Second precision: D1 stores `{ mode: "timestamp" }` columns as seconds, so
    // a millisecond component in the patch never survives the write.
    return new Date(Math.floor(t / 1000) * 1000).toISOString();
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

interface ColumnLike {
  name: string;
  dataType?: string;
  columnType?: string;
}

function normalizeForColumn(v: unknown, col: ColumnLike | undefined): string | null {
  if (col?.dataType === "boolean" && (v === 0 || v === 1)) return v === 1 ? "true" : "false";
  if (col?.dataType === "date" && typeof v === "number") {
    // A raw number handed to a timestamp column: drizzle treats it as ms.
    return normalizeFieldValue(new Date(v));
  }
  return normalizeFieldValue(v);
}

export interface BuildFieldHistoryInput {
  /** The drizzle table the patch targets — maps keys to their DB column names. */
  table: SQLiteTable;
  entityType: FieldHistoryEntityType;
  entityId: string;
  /** The row as it was before the write (a full `select()` row, or the subset the patch touches). */
  before: Record<string, unknown> | null | undefined;
  /** The `.set(...)` object about to be written. */
  patch: Record<string, unknown>;
  /** A user id, or `systemActor("<name>")`. */
  actor: string;
  /** The tool or route: `mcp:update_event`, `api:PATCH /api/admin/events/[id]`. */
  source: string;
  /** Groups the rows of one write call. Defaults to a fresh UUID. */
  requestId?: string;
  at?: Date;
  /** Extra patch keys to leave out (beyond updatedAt / createdAt). */
  ignore?: readonly string[];
}

/**
 * One row per field whose value CHANGES. A key absent from the patch, a value
 * equal to the current one, a bookkeeping column, and a raw SQL expression
 * (`sql\`view_count + 1\`` — the new value is not knowable here) produce no row.
 *
 * Pure: decides what to write; the caller inserts with its own `db`.
 */
export function buildFieldHistoryRows(input: BuildFieldHistoryInput): FieldHistoryRow[] {
  const columns = getTableColumns(input.table) as Record<string, ColumnLike>;
  const ignore = new Set([...ALWAYS_IGNORED, ...(input.ignore ?? [])]);
  const before = input.before ?? {};
  const at = input.at ?? new Date();
  const requestId = input.requestId ?? crypto.randomUUID();
  const rows: FieldHistoryRow[] = [];

  for (const [key, next] of Object.entries(input.patch)) {
    if (next === undefined) continue; // drizzle skips undefined keys in .set()
    if (ignore.has(key)) continue;
    if (is(next, SQL)) continue;
    const col = columns[key];
    if (!col) continue; // not a column of this table — drizzle would drop it too
    const oldValue = normalizeForColumn(before[key], col);
    const newValue = normalizeForColumn(next, col);
    if (oldValue === newValue) continue;
    rows.push({
      entityType: input.entityType,
      entityId: input.entityId,
      field: col.name,
      oldValue,
      newValue,
      actor: input.actor,
      source: input.source,
      requestId,
      changedAt: at,
    });
  }
  return rows;
}

/**
 * D1 caps a statement at 100 bound parameters. A history row binds 10
 * (id + 9 columns), so 9 rows per INSERT keeps every statement under the cap
 * whatever the patch size — a `values()` of all rows would throw at 11.
 */
export const FIELD_HISTORY_ROWS_PER_INSERT = 9;

/** INSERT statements for `rows`, chunked under D1's parameter cap — for a `db.batch`. */
export function fieldHistoryInserts(db: Db, rows: FieldHistoryRow[]) {
  const out = [];
  for (let i = 0; i < rows.length; i += FIELD_HISTORY_ROWS_PER_INSERT) {
    out.push(
      db.insert(schema.entityFieldHistory).values(rows.slice(i, i + FIELD_HISTORY_ROWS_PER_INSERT))
    );
  }
  return out;
}

/** Insert `rows` now (no-op for none). For write sites that do not batch. */
export async function recordFieldHistory(db: Db, rows: FieldHistoryRow[]): Promise<void> {
  for (const stmt of fieldHistoryInserts(db, rows)) await stmt;
}

export interface UpdateWithFieldHistoryInput extends Omit<BuildFieldHistoryInput, "before"> {
  /**
   * The row as it was before the write. Omit it and the columns the patch
   * writes are read first (`fieldHistoryBeforeSelect`), so a site holding no
   * row, or only a partial projection, still records what it replaced.
   */
  before?: Record<string, unknown> | null;
}

/**
 * OPE-1653 — `UPDATE <table> SET patch WHERE id = entityId` plus its history rows,
 * in ONE batch. For the unattended writers (rescrape/sync, feed ingestion,
 * enrichment apply, venue sweeps) whose edits used to replace a value with no
 * record of it.
 *
 * - No matching row → no history (the UPDATE matches nothing either).
 * - Nothing changed → the UPDATE still runs (it may carry bookkeeping such as
 *   `lastSyncedAt`), with no history rows beside it.
 *
 * Returns the history rows written, so a caller can report or test them.
 */
export async function updateWithFieldHistory(
  db: Db,
  input: UpdateWithFieldHistoryInput
): Promise<FieldHistoryRow[]> {
  const idCol = (getTableColumns(input.table) as unknown as Record<string, SQLiteColumn>).id;
  if (!idCol) throw new Error("updateWithFieldHistory: table has no `id` column");
  let before = input.before;
  if (before === undefined) {
    const found = await db
      .select(fieldHistoryBeforeSelect(input.table, input.patch))
      .from(input.table)
      .where(eq(idCol, input.entityId))
      .limit(1);
    before = (found[0] as Record<string, unknown> | undefined) ?? null;
  }
  const rows = before ? buildFieldHistoryRows({ ...input, before }) : [];
  const update = db
    .update(input.table)
    .set(input.patch as never)
    .where(eq(idCol, input.entityId));
  if (rows.length === 0) {
    await update;
  } else {
    await db.batch([update, ...fieldHistoryInserts(db, rows)] as unknown as Parameters<
      Db["batch"]
    >[0]);
  }
  return rows;
}

/**
 * A `select()` projection of exactly the columns `patch` writes — for a write
 * site whose before-row is a partial projection (or absent). Diffing against a
 * partial row would report every unselected column as "was null", so a caller
 * without the full row reads these first:
 *
 *   const [before] = await db.select(fieldHistoryBeforeSelect(events, updateData))
 *     .from(events).where(eq(events.id, id)).limit(1);
 *
 * Always includes `id`, so the projection is never empty.
 */
export function fieldHistoryBeforeSelect(
  table: SQLiteTable,
  patch: Record<string, unknown>
): Record<string, SQLiteColumn> {
  const columns = getTableColumns(table) as unknown as Record<string, SQLiteColumn>;
  const out: Record<string, SQLiteColumn> = {};
  if (columns.id) out.id = columns.id;
  for (const key of Object.keys(patch)) {
    if (columns[key] && !ALWAYS_IGNORED.has(key)) out[key] = columns[key];
  }
  return out;
}

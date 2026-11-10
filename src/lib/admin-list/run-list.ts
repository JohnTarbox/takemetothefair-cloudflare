/**
 * OPE-1595 — page-then-hydrate, the shape every admin list runs through.
 *
 * Per-row counts are correlated subqueries, and SQLite evaluates a result
 * column before it sorts, so `SELECT …, (subquery) … ORDER BY … LIMIT 50` pays
 * for the subquery on every matching row. Selecting the page's ids first, then
 * the full row for those ids alone, pays for it 50 times.
 */
import { and, asc, desc, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import type { ListParams, ListResult, SortDir } from "./params";
import { MAX_CSV_ROWS } from "./params";

/** The only drizzle query methods the runner calls; every base query has them. */
export interface ListQuery extends PromiseLike<unknown[]> {
  where(where: SQL | undefined): ListQuery;
  orderBy(...order: SQL[]): ListQuery;
  limit(n: number): ListQuery;
  offset(n: number): ListQuery;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's SelectedFields is generic over the table set; each caller's base query fixes it.
export type Fields = Record<string, any>;

export interface SortColumn {
  expr: AnyColumn | SQL;
  /** Case-insensitive ordering. Leave off where an index serves the raw order. */
  nocase?: boolean;
  /** The column cannot be empty, so it needs no empties-last term. */
  notNull?: boolean;
}

export interface ListSpec<Row extends { id: string }> {
  base: (fields: Fields) => ListQuery;
  /**
   * The base query without its joins, for the count and the page of ids. Set
   * only when the current filters and sort read no joined table.
   */
  lean?: (fields: Fields) => ListQuery;
  idColumn: AnyColumn;
  fields: Fields;
  where: (SQL | undefined)[];
  sortColumns: Record<string, SortColumn>;
  defaultSort: { sort: string; dir: SortDir };
  finish?: (rows: Row[]) => Promise<Row[]>;
  stats?: () => Promise<Record<string, number>>;
}

/**
 * Empty values go last in BOTH directions, so a row with no date or no venue
 * can never fill the top of a page. The id tiebreak keeps a row from appearing
 * on two pages when many rows share a sort value.
 */
export function orderClauses<Row extends { id: string }>(
  spec: Pick<ListSpec<Row>, "sortColumns" | "defaultSort" | "idColumn">,
  params: Pick<ListParams, "sort" | "dir">
): SQL[] {
  const known = params.sort !== null && spec.sortColumns[params.sort] !== undefined;
  const key = known ? (params.sort as string) : spec.defaultSort.sort;
  const dir = known ? params.dir : spec.defaultSort.dir;
  const column = spec.sortColumns[key];
  const expr = column.nocase ? sql`${column.expr} COLLATE NOCASE` : sql`${column.expr}`;
  const ordered = dir === "desc" ? desc(expr) : asc(expr);
  return column.notNull
    ? [ordered, asc(spec.idColumn)]
    : [sql`${column.expr} IS NULL`, ordered, asc(spec.idColumn)];
}

export async function runList<Row extends { id: string }>(
  spec: ListSpec<Row>,
  params: ListParams
): Promise<ListResult<Row>> {
  const where = and(...spec.where);
  const narrow = spec.lean ?? spec.base;
  const [counted] = (await narrow({ n: sql<number>`count(*)` }).where(where)) as {
    n: number;
  }[];
  const pageRows = (await narrow({ id: spec.idColumn })
    .where(where)
    .orderBy(...orderClauses(spec, params))
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize)) as { id: string }[];
  const ids = pageRows.map((r) => r.id);

  const byId = new Map<string, Row>();
  for (const chunk of chunkIds(ids)) {
    const hydrated = (await spec.base(spec.fields).where(inArray(spec.idColumn, chunk))) as Row[];
    for (const row of hydrated) byId.set(row.id, row);
  }
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is Row => r !== undefined);

  return {
    rows: spec.finish ? await spec.finish(ordered) : ordered,
    total: Number(counted?.n ?? 0),
    page: params.page,
    pageSize: params.pageSize,
    ...(spec.stats ? { stats: await spec.stats() } : {}),
  };
}

/** One statement, so an export does not repeat the sort once per page. */
export async function runCsvRows<Row extends { id: string }>(
  spec: ListSpec<Row>,
  params: ListParams
): Promise<Row[]> {
  const rows = (await spec
    .base(spec.fields)
    .where(and(...spec.where))
    .orderBy(...orderClauses(spec, params))
    .limit(MAX_CSV_ROWS)) as Row[];
  return spec.finish ? spec.finish(rows) : rows;
}

/**
 * OPE-1595 — the query-string contract shared by every paged admin list.
 *
 * `/api/admin/<entity>` keeps returning its plain array when called bare,
 * because the pickers on the event form, the import wizard and others need
 * every row. A request carrying `page` or `format=csv` gets one page instead.
 */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_CSV_ROWS = 20_000;

export type SortDir = "asc" | "desc";

export interface ListParams {
  page: number;
  pageSize: number;
  q: string;
  sort: string | null;
  dir: SortDir;
}

export function isPagedRequest(searchParams: URLSearchParams): boolean {
  return searchParams.has("page") || searchParams.get("format") === "csv";
}

export function isCsvRequest(searchParams: URLSearchParams): boolean {
  return searchParams.get("format") === "csv";
}

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseListParams(searchParams: URLSearchParams): ListParams {
  return {
    page: positiveInt(searchParams.get("page"), 1),
    pageSize: Math.min(positiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
    q: (searchParams.get("q") ?? "").trim(),
    sort: searchParams.get("sort"),
    dir: searchParams.get("dir") === "desc" ? "desc" : "asc",
  };
}

export interface ListResult<Row> {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  stats?: Record<string, number>;
}

export interface CsvColumn<Row> {
  header: string;
  value: (row: Row) => string | number | boolean | null | undefined | Date;
}

/** Spreadsheets run a cell that opens with one of these as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvCell(value: string | number | boolean | null | undefined | Date): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  const safe = typeof value === "string" && FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

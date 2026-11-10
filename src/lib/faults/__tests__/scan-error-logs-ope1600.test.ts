import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import { errorLogs } from "../../db/schema";
import type { Database as AppDb } from "../../db";
import { MAX_SCAN_ROWS, scanErrorLogPages, type ScanRow } from "../scan-error-logs";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const SINCE = new Date("2026-11-01T00:00:00Z");
const NOW_SEC = Math.floor(new Date("2026-11-09T00:00:00Z").getTime() / 1000);

let raw: InstanceType<typeof Database>;
let db: AppDb;

function insert(
  id: string,
  ts: number,
  level = "error",
  source = "app/x",
  stack: string | null = null
) {
  raw
    .prepare(
      "INSERT INTO error_logs (id, timestamp, level, message, source, stack_trace) VALUES (?,?,?,?,?,?)"
    )
    .run(id, ts, level, "boom", source, stack);
}

async function collect(max?: number): Promise<ScanRow[][]> {
  const pages: ScanRow[][] = [];
  for await (const page of scanErrorLogPages(db, SINCE, ["mcp:heartbeat"], max)) pages.push(page);
  return pages;
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(ddlFor(errorLogs));
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

describe("scanErrorLogPages", () => {
  it("returns every row exactly once across pages when a burst shares one second", async () => {
    // A D1 overload burst writes hundreds of rows inside one second, so a
    // timestamp-only cursor would skip or repeat them at each page boundary.
    for (let i = 0; i < 1200; i++) insert(`id-${String(i).padStart(4, "0")}`, NOW_SEC);
    const pages = await collect();
    expect(pages.map((p) => p.length)).toEqual([500, 500, 200]);
    const ids = pages.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(1200);
  });

  it("stops at the row cap and keeps newest first", async () => {
    for (let i = 0; i < 30; i++) insert(`r${i}`, NOW_SEC - i);
    const pages = await collect(12);
    const rows = pages.flat();
    expect(rows).toHaveLength(12);
    expect(rows[0].id).toBe("r0");
    expect(MAX_SCAN_ROWS).toBe(5000);
  });

  it("applies the level, window and excluded-source filters", async () => {
    insert("keep", NOW_SEC);
    insert("info", NOW_SEC, "info");
    insert("self", NOW_SEC, "error", "mcp:heartbeat");
    insert("old", Math.floor(SINCE.getTime() / 1000) - 10);
    expect((await collect()).flat().map((r) => r.id)).toEqual(["keep"]);
  });

  it("loads only the stack prefix the noise check needs", async () => {
    insert("s", NOW_SEC, "error", "app/x", "x".repeat(9000));
    const [row] = (await collect()).flat();
    expect(row.stackTrace).toHaveLength(2000);
  });
});

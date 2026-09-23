export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { quoteKnownTable, UnknownTableError } from "@/lib/db/known-table-identifier";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { withAuth } from "@/lib/api/with-auth";
import { logError } from "@/lib/logger";

interface TableStats {
  name: string;
  rowCount: number;
}

// GET - Get database statistics. `db` (drizzle, for logError) is aliased
// errorDb to leave the local `db = env.DB` (raw D1, for prepare()) untouched.
export const GET = withAuth({ role: "ADMIN" }, async ({ request, db: errorDb }) => {
  try {
    const env = getCloudflareEnv();
    const db = env.DB;

    // Get all table names
    const tablesResult = await db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
      ORDER BY name
    `
      )
      .all();

    const tables: TableStats[] = [];
    // OPE-1105 — the only names allowed into the interpolated query below.
    const knownTables = new Set(tablesResult.results.map((r) => r.name as string));

    for (const row of tablesResult.results) {
      const tableName = row.name as string;
      // A table name cannot be bound as a parameter in SQLite, so it is
      // interpolated — through the allow-list, never raw. Refused (400) below.
      const quoted = quoteKnownTable(tableName, knownTables);
      try {
        const countResult = await db.prepare(`SELECT COUNT(*) as count FROM ${quoted}`).first();
        tables.push({
          name: tableName,
          rowCount: (countResult?.count as number) || 0,
        });
      } catch {
        tables.push({
          name: tableName,
          rowCount: -1, // Error getting count
        });
      }
    }

    // Get index count
    const indexResult = await db
      .prepare(
        `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type='index'
      AND name NOT LIKE 'sqlite_%'
    `
      )
      .first();

    const totalRows = tables.reduce((sum, t) => sum + (t.rowCount > 0 ? t.rowCount : 0), 0);

    return NextResponse.json({
      tables,
      summary: {
        tableCount: tables.length,
        totalRows,
        indexCount: (indexResult?.count as number) || 0,
      },
    });
  } catch (error) {
    // OPE-1105 — a table name outside the sqlite_master allow-list is refused
    // before it reaches SQL.
    if (error instanceof UnknownTableError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await logError(errorDb, {
      message: "Stats error",
      error,
      source: "api/admin/database/stats",
      request,
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get database stats" },
      { status: 500 }
    );
  }
});

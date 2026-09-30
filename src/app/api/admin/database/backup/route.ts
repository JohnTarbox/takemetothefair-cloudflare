export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getCloudflareEnv, getCloudflareDb } from "@/lib/cloudflare";
import { requireAdminAuth } from "@/lib/api-auth";
import { logError } from "@/lib/logger";
import { checkAdminGeoRestriction } from "@/lib/geo-security";
import { quoteKnownTable, UnknownTableError } from "@/lib/db/known-table-identifier";

// GET - Generate and download a database backup
export async function GET(request: NextRequest) {
  // Geo-restriction check for sensitive database operations
  const geoResult = checkAdminGeoRestriction(request);
  if (!geoResult.allowed) {
    return NextResponse.json({ error: "Access denied from your location" }, { status: 403 });
  }

  const fail = await requireAdminAuth(request);
  if (fail) return fail;

  const errorDb = getCloudflareDb();
  try {
    const env = getCloudflareEnv();
    const db = env.DB;

    // Get all table names (excluding SQLite internals and D1 migrations)
    const tablesResult = await db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
      AND name != 'd1_migrations'
      ORDER BY name
    `
      )
      .all();

    const tables = tablesResult.results.map((row) => row.name as string);
    // OPE-1105 — the only names allowed into the interpolated queries below.
    const knownTables = new Set(tables);

    let sqlDump = `-- Database Backup\n`;
    sqlDump += `-- Generated: ${new Date().toISOString()}\n`;
    sqlDump += `-- Tables: ${tables.length}\n\n`;

    // For each table, get schema and data
    for (const tableName of tables) {
      // OPE-1105 — ONE validated value for every use of the name in this loop.
      // The schema lookup can bind it (it is a VALUE there); the SELECT and the
      // dump's DROP/INSERT cannot (it is an IDENTIFIER there), so those use the
      // allow-listed, quote-escaped form. Refused (400) below if unknown.
      const quoted = quoteKnownTable(tableName, knownTables);

      // Get CREATE TABLE statement
      const schemaResult = await db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .bind(tableName)
        .first();

      if (schemaResult?.sql) {
        sqlDump += `-- Table: ${tableName}\n`;
        sqlDump += `DROP TABLE IF EXISTS ${quoted};\n`;
        sqlDump += `${schemaResult.sql};\n\n`;
      }

      // Get all data from table
      const dataResult = await db.prepare(`SELECT * FROM ${quoted}`).all();

      if (dataResult.results.length > 0) {
        const columns = Object.keys(dataResult.results[0]);

        for (const row of dataResult.results) {
          const values = columns.map((col) => {
            const val = (row as Record<string, unknown>)[col];
            if (val === null) return "NULL";
            if (typeof val === "number") return val.toString();
            if (typeof val === "boolean") return val ? "1" : "0";
            // Escape single quotes in strings
            return `'${String(val).replace(/'/g, "''")}'`;
          });

          sqlDump += `INSERT INTO ${quoted} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});\n`;
        }
        sqlDump += "\n";
      }
    }

    // Get indexes
    const indexesResult = await db
      .prepare(
        `
      SELECT sql FROM sqlite_master
      WHERE type='index'
      AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    `
      )
      .all();

    if (indexesResult.results.length > 0) {
      sqlDump += `-- Indexes\n`;
      for (const row of indexesResult.results) {
        if (row.sql) {
          sqlDump += `${row.sql};\n`;
        }
      }
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `takemetothefair-backup-${timestamp}.sql`;

    // Return as downloadable file
    return new Response(sqlDump, {
      headers: {
        "Content-Type": "application/sql",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    // OPE-1105 — a table name outside the sqlite_master allow-list is refused
    // before it reaches SQL.
    if (error instanceof UnknownTableError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await logError(errorDb, {
      message: "Backup error",
      error,
      source: "api/admin/database/backup",
      request,
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create backup" },
      { status: 500 }
    );
  }
}

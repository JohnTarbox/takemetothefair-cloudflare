import { NextResponse } from "next/server";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { auth } from "@/lib/auth";

export const runtime = "edge";

interface TableStats {
  name: string;
  rowCount: number;
}

// GET - Get database statistics
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const env = getCloudflareEnv();
    const db = env.DB;

    // Get all table names
    const tablesResult = await db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
      ORDER BY name
    `).all();

    const tables: TableStats[] = [];

    for (const row of tablesResult.results) {
      const tableName = row.name as string;
      try {
        const countResult = await db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).first();
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
    const indexResult = await db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type='index'
      AND name NOT LIKE 'sqlite_%'
    `).first();

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
    console.error("Stats error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get database stats" },
      { status: 500 }
    );
  }
}

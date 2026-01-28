import { NextResponse } from "next/server";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { auth } from "@/lib/auth";

export const runtime = "edge";

// POST - Restore database from SQL backup
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const confirmRestore = formData.get("confirm") as string;

    if (confirmRestore !== "yes-restore-database") {
      return NextResponse.json(
        { error: "Restoration not confirmed. Please confirm by typing 'yes-restore-database'" },
        { status: 400 }
      );
    }

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const sqlContent = await file.text();

    if (!sqlContent.trim()) {
      return NextResponse.json({ error: "Empty SQL file" }, { status: 400 });
    }

    const env = getCloudflareEnv();
    const db = env.DB;

    // Parse SQL statements (split by semicolons, but handle quoted strings)
    const statements = parseSqlStatements(sqlContent);

    const results = {
      total: statements.length,
      executed: 0,
      dropped: 0,
      created: 0,
      inserted: 0,
      indexes: 0,
      errors: [] as string[],
    };

    // Execute each statement
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (!trimmed || trimmed.startsWith("--")) continue;

      try {
        await db.prepare(trimmed).run();
        results.executed++;

        // Track statement types
        const upper = trimmed.toUpperCase();
        if (upper.startsWith("DROP")) results.dropped++;
        else if (upper.startsWith("CREATE TABLE")) results.created++;
        else if (upper.startsWith("CREATE INDEX")) results.indexes++;
        else if (upper.startsWith("INSERT")) results.inserted++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        // Don't fail on "table already exists" or similar
        if (!errorMsg.includes("already exists")) {
          results.errors.push(`Statement failed: ${trimmed.substring(0, 100)}... Error: ${errorMsg}`);
        }
      }
    }

    return NextResponse.json({
      success: true,
      message: `Restore completed. ${results.executed} statements executed.`,
      details: {
        tablesDropped: results.dropped,
        tablesCreated: results.created,
        rowsInserted: results.inserted,
        indexesCreated: results.indexes,
        errors: results.errors.slice(0, 10), // Limit error messages
        totalErrors: results.errors.length,
      },
    });
  } catch (error) {
    console.error("Restore error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to restore database" },
      { status: 500 }
    );
  }
}

// Parse SQL statements, handling semicolons within quoted strings
function parseSqlStatements(sqlContent: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < sqlContent.length; i++) {
    const char = sqlContent[i];
    const prevChar = i > 0 ? sqlContent[i - 1] : "";

    // Handle string boundaries
    if ((char === "'" || char === '"') && prevChar !== "\\") {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        // Check for escaped quote ('')
        if (sqlContent[i + 1] === char) {
          current += char;
          i++; // Skip next char
        } else {
          inString = false;
          stringChar = "";
        }
      }
    }

    // Check for statement end
    if (char === ";" && !inString) {
      const trimmed = current.trim();
      if (trimmed && !trimmed.startsWith("--")) {
        statements.push(trimmed);
      }
      current = "";
    } else {
      current += char;
    }
  }

  // Don't forget the last statement if no trailing semicolon
  const trimmed = current.trim();
  if (trimmed && !trimmed.startsWith("--")) {
    statements.push(trimmed);
  }

  return statements;
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { errorLogs } from "@/lib/db/schema";
import { desc, eq, like, and, sql, lt } from "drizzle-orm";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const level = searchParams.get("level");
  const q = searchParams.get("q");
  const source = searchParams.get("source");

  try {
    const db = getCloudflareDb();

    const conditions = [];
    if (level) conditions.push(eq(errorLogs.level, level));
    if (source) conditions.push(like(errorLogs.source, `%${source}%`));
    if (q) conditions.push(like(errorLogs.message, `%${q}%`));

    const logs = await db
      .select({
        id: errorLogs.id,
        timestamp: errorLogs.timestamp,
        level: errorLogs.level,
        message: errorLogs.message,
        context: errorLogs.context,
        url: errorLogs.url,
        method: errorLogs.method,
        statusCode: errorLogs.statusCode,
        stackTrace: errorLogs.stackTrace,
        userAgent: errorLogs.userAgent,
        source: errorLogs.source,
        time: sql<string>`datetime(${errorLogs.timestamp}, 'unixepoch')`.as("time"),
      })
      .from(errorLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(errorLogs.timestamp))
      .limit(limit);

    return NextResponse.json(logs);
  } catch (error) {
    console.error("Failed to fetch error logs:", error);
    return NextResponse.json(
      { error: "Failed to fetch error logs" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get("id");
  const olderThan = searchParams.get("olderThan"); // days

  try {
    const db = getCloudflareDb();

    if (id) {
      // Delete a single log entry
      await db.delete(errorLogs).where(eq(errorLogs.id, id));
      return NextResponse.json({ deleted: 1 });
    }

    if (olderThan) {
      // Delete logs older than N days
      const days = parseInt(olderThan, 10);
      if (isNaN(days) || days < 1) {
        return NextResponse.json(
          { error: "olderThan must be a positive number" },
          { status: 400 }
        );
      }
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const result = await db
        .delete(errorLogs)
        .where(lt(errorLogs.timestamp, cutoff));
      return NextResponse.json({ deleted: result.rowsAffected ?? 0 });
    }

    return NextResponse.json(
      { error: "Specify 'id' or 'olderThan' parameter" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Failed to delete error logs:", error);
    return NextResponse.json(
      { error: "Failed to delete error logs" },
      { status: 500 }
    );
  }
}

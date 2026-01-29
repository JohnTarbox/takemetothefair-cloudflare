import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { errorLogs } from "@/lib/db/schema";
import { desc, eq, like, and, sql } from "drizzle-orm";

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

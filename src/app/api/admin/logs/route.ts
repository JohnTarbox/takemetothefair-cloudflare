export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api/with-auth";
import { errorLogs } from "@/lib/db/schema";
import { desc, eq, like, and, sql, lt } from "drizzle-orm";

export const GET = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const level = searchParams.get("level");
  const q = searchParams.get("q");
  const source = searchParams.get("source");

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
      // strftime/datetime expect seconds; column stores seconds (mode:"timestamp").
      time: sql<string>`datetime(${errorLogs.timestamp}, 'unixepoch')`.as("time"),
    })
    .from(errorLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(errorLogs.timestamp))
    .limit(limit);

  return NextResponse.json(logs);
});

export const DELETE = withAuth({ role: "ADMIN" }, async ({ request, db }) => {
  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get("id");
  const olderThan = searchParams.get("olderThan"); // days

  if (id) {
    // Delete a single log entry
    await db.delete(errorLogs).where(eq(errorLogs.id, id));
    return NextResponse.json({ deleted: 1 });
  }

  if (olderThan) {
    // Delete logs older than N days
    const days = parseInt(olderThan, 10);
    if (isNaN(days) || days < 1) {
      return NextResponse.json({ error: "olderThan must be a positive number" }, { status: 400 });
    }
    const cutoff = new Date(Date.now() - days * 86400 * 1000);
    const result = await db.delete(errorLogs).where(lt(errorLogs.timestamp, cutoff));
    return NextResponse.json({ deleted: result.meta?.changes ?? 0 });
  }

  return NextResponse.json({ error: "Specify 'id' or 'olderThan' parameter" }, { status: 400 });
});

import { NextResponse } from "next/server";
import { getCloudflareDb } from "@/lib/cloudflare";
import { sql } from "drizzle-orm";

export const runtime = "edge";

export async function GET() {
  const checks: Record<string, { status: string; latencyMs?: number }> = {};

  // Check D1 database connectivity
  try {
    const start = Date.now();
    const db = getCloudflareDb();
    await db.run(sql`SELECT 1`);
    checks.database = { status: "ok", latencyMs: Date.now() - start };
  } catch {
    checks.database = { status: "error" };
  }

  const allHealthy = Object.values(checks).every((c) => c.status === "ok");

  return NextResponse.json(
    { status: allHealthy ? "healthy" : "degraded", checks },
    { status: allHealthy ? 200 : 503 }
  );
}

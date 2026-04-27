import { NextResponse } from "next/server";
import { getCloudflareDb, getCloudflareRateLimitKv } from "@/lib/cloudflare";
import { sql } from "drizzle-orm";

interface HealthCheck {
  status: "ok" | "error" | "degraded";
  latencyMs?: number;
  message?: string;
}

export async function GET() {
  const checks: Record<string, HealthCheck> = {};

  // Run all checks concurrently
  const [dbResult, kvResult, aiResult] = await Promise.allSettled([
    checkDatabase(),
    checkKV(),
    checkWorkersAI(),
  ]);

  checks.database =
    dbResult.status === "fulfilled" ? dbResult.value : { status: "error", message: "Check failed" };
  checks.kv =
    kvResult.status === "fulfilled" ? kvResult.value : { status: "error", message: "Check failed" };
  checks.workersAi =
    aiResult.status === "fulfilled" ? aiResult.value : { status: "error", message: "Check failed" };

  // DB is critical; KV and AI are non-critical (degraded, not down)
  const dbHealthy = checks.database.status === "ok";
  const allHealthy = Object.values(checks).every((c) => c.status === "ok");

  const overallStatus = !dbHealthy ? "unhealthy" : allHealthy ? "healthy" : "degraded";

  return NextResponse.json(
    {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: dbHealthy ? 200 : 503 }
  );
}

async function checkDatabase(): Promise<HealthCheck> {
  try {
    const start = Date.now();
    const db = getCloudflareDb();
    await db.run(sql`SELECT 1`);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return { status: "error", message: "D1 database unreachable" };
  }
}

async function checkKV(): Promise<HealthCheck> {
  try {
    const start = Date.now();
    const kv = getCloudflareRateLimitKv();
    if (!kv) {
      return { status: "degraded", message: "KV binding not available" };
    }
    // Read a non-existent key — tests connectivity without side effects
    await kv.get("__health_check__");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return { status: "error", message: "KV namespace unreachable" };
  }
}

async function checkWorkersAI(): Promise<HealthCheck> {
  try {
    const start = Date.now();
    // Attempt to get the AI binding — availability check only
    const { getCloudflareAi } = await import("@/lib/cloudflare");
    const ai = getCloudflareAi();
    if (!ai) {
      return { status: "degraded", message: "AI binding not available" };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return { status: "degraded", message: "Workers AI binding unavailable" };
  }
}

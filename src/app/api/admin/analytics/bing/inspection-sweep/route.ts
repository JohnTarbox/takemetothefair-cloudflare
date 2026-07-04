export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { runBingSweep } from "@/lib/bing-inspection-sweep";
import type { BingEnv } from "@/lib/bing-webmaster";

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  // Default 10 — Bing's GetUrlInfo is cached 15m and quota-limited, so keep the
  // batch modest. Larger callers (cron / manual curl) can pass ?batchSize=N up
  // to 100.
  const batchSize = Math.min(parseInt(url.searchParams.get("batchSize") || "10", 10), 100);

  const env = getCloudflareEnv() as unknown as BingEnv;
  const db = getCloudflareDb();
  try {
    const stats = await runBingSweep(db, env, { batchSize });
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

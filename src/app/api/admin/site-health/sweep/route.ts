import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { runSweep } from "@/lib/gsc-sweep";
import type { ScEnv } from "@/lib/search-console";

export const runtime = "edge";

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const batchSize = Math.min(parseInt(url.searchParams.get("batchSize") || "200", 10), 500);

  const env = getCloudflareEnv() as unknown as ScEnv;
  const db = getCloudflareDb();
  try {
    const stats = await runSweep(db, env, { batchSize });
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { refreshIssues } from "@/lib/site-health";
import type { BingEnv } from "@/lib/bing-webmaster";
import type { ScEnv } from "@/lib/search-console";

export const runtime = "edge";

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const env = getCloudflareEnv() as unknown as BingEnv & ScEnv;
  const db = getCloudflareDb();
  try {
    const stats = await refreshIssues(db, env, env);
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

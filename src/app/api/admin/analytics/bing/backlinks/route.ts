export const dynamic = "force-dynamic";
// K50 — site pages with inbound links + counts (GetLinkCounts). `page` is Bing's
// pagination index. Surfaces the referring-domains / backlinks finding that
// previously required a hand export.
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { BingApiError, BingConfigError, getBacklinks, type BingEnv } from "@/lib/bing-webmaster";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const skipCache = url.searchParams.get("refresh") === "1";
  const page = Number(url.searchParams.get("page") ?? 0) || 0;
  try {
    const env = getCloudflareEnv() as unknown as BingEnv;
    const data = await getBacklinks(env, { page, skipCache });
    return NextResponse.json({ success: true, data, page });
  } catch (error) {
    if (error instanceof BingConfigError) {
      return NextResponse.json(
        { success: false, error: "config", message: error.message },
        { status: 503 }
      );
    }
    if (error instanceof BingApiError) {
      return NextResponse.json(
        { success: false, error: "api", message: error.detail, status: error.status },
        { status: 502 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
// A12 read surface — clicks/impressions/CTR/avg-position over time from the
// persisted GSC trend store (gsc_search_metrics), NOT a live GSC call. Optional
// query/page/date-window filters. Backs the get_gsc_trend MCP tool.
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { getGscTrend } from "@/lib/gsc-trend";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  try {
    const data = await getGscTrend(getCloudflareDb(), {
      query: url.searchParams.get("query") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      startDate: url.searchParams.get("startDate") ?? undefined,
      endDate: url.searchParams.get("endDate") ?? undefined,
      siteUrl: url.searchParams.get("siteUrl") ?? undefined,
    });
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

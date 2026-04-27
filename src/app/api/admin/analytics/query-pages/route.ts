import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { getQueryPages, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { DateRangeError, parseAnalyticsParams } from "@/lib/analytics-params";

/**
 * GET /api/admin/analytics/query-pages?query=X
 * Returns every page that ranked for the given search query, with per-page
 * impressions/clicks/position. Used for cannibalization detection.
 * Auth: admin session OR X-Internal-Key header.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("query");
  if (!query || !query.trim()) {
    return NextResponse.json(
      {
        success: false,
        error: "bad_request",
        message: "Missing 'query' parameter.",
      },
      { status: 400 }
    );
  }

  const params = parseAnalyticsParams(url.searchParams);

  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const result = await getQueryPages(env, query, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
      rowLimit: params.rowLimit,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof DateRangeError) {
      return NextResponse.json(
        { success: false, error: "bad_request", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof ScConfigError) {
      return NextResponse.json(
        { success: false, error: "config", message: error.message },
        { status: 503 }
      );
    }
    if (error instanceof ScApiError) {
      return NextResponse.json(
        { success: false, error: "sc_api", status: error.status, message: error.detail },
        { status: 502 }
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        { success: false, error: "timeout", message: "Search Console request timed out" },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

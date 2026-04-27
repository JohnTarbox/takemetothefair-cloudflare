import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { Ga4ApiError, Ga4ConfigError, getDashboardMetrics, type Ga4Env } from "@/lib/ga4";
import { DateRangeError, parseAnalyticsParams } from "@/lib/analytics-params";

/**
 * GET /api/admin/analytics/ga4
 * Returns server-fetched GA4 metrics for the admin analytics page.
 * Query params: startDate, endDate, preset, comparePreviousPeriod, pathPrefix,
 *   rowLimit, orderBy, minViews, refresh.
 * Auth: admin session OR X-Internal-Key header (for MCP server).
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const params = parseAnalyticsParams(url.searchParams);

  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const metrics = await getDashboardMetrics(env, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
      comparePreviousPeriod: params.comparePreviousPeriod,
      topPages: {
        pathPrefix: params.pathPrefix,
        rowLimit: params.rowLimit,
        orderBy: params.orderBy as "views" | "users" | "sessions" | "engagementRate" | undefined,
        minViews: params.minViews,
      },
    });
    return NextResponse.json({ success: true, metrics });
  } catch (error) {
    if (error instanceof DateRangeError) {
      return NextResponse.json(
        { success: false, error: "bad_request", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof Ga4ConfigError) {
      return NextResponse.json(
        { success: false, error: "config", message: error.message },
        { status: 503 }
      );
    }
    if (error instanceof Ga4ApiError) {
      return NextResponse.json(
        {
          success: false,
          error: "ga4_api",
          status: error.status,
          message: error.detail,
        },
        { status: 502 }
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        {
          success: false,
          error: "timeout",
          message: "GA4 request timed out",
        },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

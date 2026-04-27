import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { Ga4ApiError, Ga4ConfigError, getPageMetrics, type Ga4Env } from "@/lib/ga4";
import { DateRangeError, parseAnalyticsParams } from "@/lib/analytics-params";

/**
 * GET /api/admin/analytics/page?path=/events
 * Returns per-page GA4 metrics (totals, deltas, daily series, sources, devices, events).
 * Query params: path (required), startDate, endDate, preset, refresh.
 * Auth: admin session OR X-Internal-Key header (for MCP server).
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path || !path.startsWith("/")) {
    return NextResponse.json(
      {
        success: false,
        error: "bad_request",
        message: "Missing or invalid 'path' parameter (must start with '/').",
      },
      { status: 400 }
    );
  }

  const params = parseAnalyticsParams(url.searchParams);

  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const metrics = await getPageMetrics(env, path, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
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
        { success: false, error: "ga4_api", status: error.status, message: error.detail },
        { status: 502 }
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        { success: false, error: "timeout", message: "GA4 request timed out" },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { getSiteSearchQueries, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { DateRangeError, parseAnalyticsParams } from "@/lib/analytics-params";

type ScOrderBy = "impressions" | "clicks" | "position" | "ctr";

/**
 * GET /api/admin/analytics/search-queries/site
 * Returns site-wide Search Console queries aggregated across pages.
 * Query params: pathPrefix, startDate, endDate, preset, rowLimit,
 *   minImpressions, orderBy, refresh.
 * Auth: admin session OR X-Internal-Key header (for MCP server).
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const params = parseAnalyticsParams(url.searchParams);

  const allowedOrderBy: ScOrderBy[] = ["impressions", "clicks", "position", "ctr"];
  const orderBy = params.orderBy as ScOrderBy | undefined;
  if (orderBy && !allowedOrderBy.includes(orderBy)) {
    return NextResponse.json(
      {
        success: false,
        error: "bad_request",
        message: `orderBy must be one of: ${allowedOrderBy.join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const result = await getSiteSearchQueries(env, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
      pathPrefix: params.pathPrefix,
      rowLimit: params.rowLimit,
      minImpressions: params.minImpressions,
      orderBy,
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

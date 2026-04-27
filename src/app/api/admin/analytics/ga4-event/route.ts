import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { Ga4ApiError, Ga4ConfigError, getGa4EventDetail, type Ga4Env } from "@/lib/ga4";
import { DateRangeError, parseAnalyticsParams } from "@/lib/analytics-params";

/**
 * GET /api/admin/analytics/ga4-event?eventName=X&topParameters=endpoint,status_code&topN=20[&path=/foo]
 * Returns top parameter-value combinations for a GA4 event. Parameters must be
 * registered as custom dimensions in GA4 Admin for data to populate.
 * Auth: admin session OR X-Internal-Key header.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const eventName = url.searchParams.get("eventName");
  if (!eventName || !eventName.trim()) {
    return NextResponse.json(
      { success: false, error: "bad_request", message: "Missing 'eventName' parameter." },
      { status: 400 }
    );
  }

  const path = url.searchParams.get("path");
  if (path && !path.startsWith("/")) {
    return NextResponse.json(
      { success: false, error: "bad_request", message: "'path' must start with '/' if provided." },
      { status: 400 }
    );
  }

  const topParametersRaw = url.searchParams.get("topParameters") ?? "";
  const topParameters = topParametersRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (topParameters.length > 9) {
    return NextResponse.json(
      {
        success: false,
        error: "bad_request",
        message: "topParameters supports at most 9 parameter names.",
      },
      { status: 400 }
    );
  }

  const topNRaw = url.searchParams.get("topN");
  const topN = topNRaw ? Math.max(1, Math.min(Number(topNRaw), 100)) : undefined;

  const params = parseAnalyticsParams(url.searchParams);

  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const result = await getGa4EventDetail(env, eventName, {
      skipCache: params.refresh,
      dateRange: params.dateRange,
      path: path ?? undefined,
      topParameters,
      topN,
    });
    return NextResponse.json({ success: true, ...result });
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

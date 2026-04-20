import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { inspectUrl, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { parseAnalyticsParams } from "@/lib/analytics-params";

export const runtime = "edge";

/**
 * GET /api/admin/analytics/url-inspection?path=/events
 * Runs the Search Console URL Inspection API for a single path. Rate-limited
 * to 2000/day per property by Google; result cached 6h.
 * Auth: admin session OR X-Internal-Key header.
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
    const env = getCloudflareEnv() as unknown as ScEnv;
    const result = await inspectUrl(env, path, { skipCache: params.refresh });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
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

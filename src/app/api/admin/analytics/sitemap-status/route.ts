import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { getSitemapStatus, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { parseAnalyticsParams } from "@/lib/analytics-params";

export const runtime = "edge";

/**
 * GET /api/admin/analytics/sitemap-status
 * Returns indexed-vs-submitted counts for all sitemaps registered in Search
 * Console. Cached for 24 hours. Auth: admin session OR X-Internal-Key.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const params = parseAnalyticsParams(url.searchParams);

  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const result = await getSitemapStatus(env, { skipCache: params.refresh });
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

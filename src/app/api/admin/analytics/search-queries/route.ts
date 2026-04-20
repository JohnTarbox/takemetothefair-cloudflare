import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  getSearchQueriesForPage,
  ScApiError,
  ScConfigError,
  type ScEnv,
} from "@/lib/search-console";

export const runtime = "edge";

/**
 * GET /api/admin/analytics/search-queries?path=/events
 * Returns top Search Console queries for a specific page (last 30 days).
 * Pass ?refresh=1 to bypass KV caches.
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

  const skipCache = url.searchParams.get("refresh") === "1";

  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const queries = await getSearchQueriesForPage(env, path, { skipCache });
    return NextResponse.json({ success: true, path, queries });
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

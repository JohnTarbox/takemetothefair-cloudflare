import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { Ga4ApiError, Ga4ConfigError, getDashboardMetrics, type Ga4Env } from "@/lib/ga4";

export const runtime = "edge";

/**
 * GET /api/admin/analytics/ga4
 * Returns server-fetched GA4 metrics for the admin analytics page.
 * Pass ?refresh=1 to bypass KV caches.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const skipCache = url.searchParams.get("refresh") === "1";

  try {
    const env = getCloudflareEnv() as unknown as Ga4Env;
    const metrics = await getDashboardMetrics(env, { skipCache });
    return NextResponse.json({ success: true, metrics });
  } catch (error) {
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

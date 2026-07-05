export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { inspectUrl, ScApiError, ScConfigError, type ScEnv } from "@/lib/search-console";
import { parseAnalyticsParams } from "@/lib/analytics-params";
import { logError } from "@/lib/logger";
import { persistGscInspectionState } from "@/lib/inspection-state-persist";
import { SITE_URL } from "@takemetothefair/constants";

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

  // OPE-102 — when persist=1, the read doubles as a state-table refresh so an
  // operator/analyst call lands a gsc_inspection_state row (no separate hand-UPSERT).
  const persist = url.searchParams.get("persist") === "1";

  try {
    const env = getCloudflareEnv() as unknown as ScEnv;
    const result = await inspectUrl(env, path, { skipCache: params.refresh });

    if (persist) {
      // Fail-open: the read is the primary contract — a write hiccup must not
      // fail the response. Best-effort, logged for observability.
      try {
        await persistGscInspectionState(getCloudflareDb(), {
          url: `${SITE_URL}${path}`,
          verdict: result.index.verdict,
          coverage: result.index.coverageState,
        });
      } catch (writeErr) {
        try {
          await logError(getCloudflareDb(), {
            source: "api/url-inspection:persist",
            message: "persist gsc_inspection_state failed (read returned OK)",
            error: writeErr,
            context: { path },
          });
        } catch {
          /* observability only */
        }
      }
    }

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

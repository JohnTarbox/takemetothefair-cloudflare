export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { BingApiError, BingConfigError, getUrlInfo, type BingEnv } from "@/lib/bing-webmaster";
import { logError } from "@/lib/logger";
import { persistBingInspectionState } from "@/lib/inspection-state-persist";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const reqUrl = new URL(request.url);
  const url = reqUrl.searchParams.get("url");
  const skipCache = reqUrl.searchParams.get("refresh") === "1";
  // OPE-102 — when persist=1, the read doubles as a bing_inspection_state refresh.
  const persist = reqUrl.searchParams.get("persist") === "1";
  if (!url) {
    return NextResponse.json(
      { success: false, error: "invalid_payload", message: "Missing ?url=" },
      { status: 400 }
    );
  }
  try {
    const env = getCloudflareEnv() as unknown as BingEnv;
    const data = await getUrlInfo(env, url, { skipCache });

    if (persist) {
      // Fail-open: the read is the primary contract; a write hiccup must not fail
      // the response. Best-effort, logged for observability.
      try {
        await persistBingInspectionState(getCloudflareDb(), {
          url,
          isIndexed: data.isIndexed,
          lastCrawled: data.lastCrawled,
          crawlError: data.crawlError,
        });
      } catch (writeErr) {
        try {
          await logError(getCloudflareDb(), {
            source: "api/bing-url-info:persist",
            message: "persist bing_inspection_state failed (read returned OK)",
            error: writeErr,
            context: { url },
          });
        } catch {
          /* observability only */
        }
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof BingConfigError) {
      return NextResponse.json(
        { success: false, error: "config", message: error.message },
        { status: 503 }
      );
    }
    if (error instanceof BingApiError) {
      return NextResponse.json(
        { success: false, error: "api", message: error.detail, status: error.status },
        { status: 502 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  BingApiError,
  BingConfigError,
  getSiteScanIssues,
  type BingEnv,
} from "@/lib/bing-webmaster";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const skipCache = url.searchParams.get("refresh") === "1";
  try {
    const env = getCloudflareEnv() as unknown as BingEnv;
    const data = await getSiteScanIssues(env, { skipCache });
    // K50 — make an empty result self-explanatory. This endpoint surfaces
    // GetCrawlIssues (Bingbot crawl-discovered errors: 404 / blocked / 5xx),
    // which is the ONLY crawl-quality surface in the Webmaster API. The BWT UI
    // "Site Scan" on-page SEO analysis (short metas / missing alt / H1 counts)
    // is a DIFFERENT product surface that Microsoft does not expose via API —
    // so an empty `data` here means "Bingbot found no crawl errors" (healthy),
    // NOT "the tool is broken". The UI SEO analysis must be read from
    // bing.com/webmasters directly.
    const note =
      data.length === 0
        ? "No Bingbot crawl issues (404/blocked/5xx) detected — healthy. NOTE: the BWT UI 'Site Scan' on-page SEO analysis (meta/alt/H1) is not available via the Webmaster API; read it from bing.com/webmasters."
        : undefined;
    return NextResponse.json({ success: true, data, source: "GetCrawlIssues", note });
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

export const dynamic = "force-dynamic";
// K50 — bulk paginated index details for URLs under a directory
// (GetChildrenUrlInfo). `dir` defaults to the site root; `page` is Bing's
// pagination index. This is the bulk list SEO-CRAWL1 used to find the /register
// crawl-budget leak (GetUrlInfo is single-URL only).
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { BingApiError, BingConfigError, getCrawledUrls, type BingEnv } from "@/lib/bing-webmaster";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const skipCache = url.searchParams.get("refresh") === "1";
  const dir = url.searchParams.get("dir") ?? undefined;
  const page = Number(url.searchParams.get("page") ?? 0) || 0;
  try {
    const env = getCloudflareEnv() as unknown as BingEnv;
    const data = await getCrawledUrls(env, { dir, page, skipCache });
    return NextResponse.json({ success: true, data, dir: dir ?? null, page });
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

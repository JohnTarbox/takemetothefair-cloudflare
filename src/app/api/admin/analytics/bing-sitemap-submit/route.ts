export const dynamic = "force-dynamic";
/**
 * Re-submit a sitemap to Bing Webmaster Tools — the Bing equivalent of
 * /api/admin/analytics/sitemap-submit (which targets GSC). Used after
 * segmented-sitemap changes where `get_bing_sitemaps` shows null
 * submission timestamps for the index file.
 *
 * Auth: admin session OR X-Internal-Key (same shape as the GSC route).
 * The BING_WEBMASTER_API_KEY secret lives only in Cloudflare Pages env
 * — there is no local development path; the route is deploy-only.
 */
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { BingApiError, BingConfigError, submitFeed, type BingEnv } from "@/lib/bing-webmaster";

type PostBody = { sitemap_url?: unknown };

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid_json", message: "Body must be valid JSON." },
      { status: 400 }
    );
  }

  const sitemapUrl = typeof body.sitemap_url === "string" ? body.sitemap_url.trim() : "";
  if (!sitemapUrl) {
    return NextResponse.json(
      {
        success: false,
        error: "missing_sitemap_url",
        message: "Body must include `sitemap_url` (string).",
      },
      { status: 400 }
    );
  }

  const env = getCloudflareEnv() as unknown as BingEnv;
  try {
    const result = await submitFeed(env, sitemapUrl);
    return NextResponse.json({
      success: true,
      sitemap_url: result.feedUrl,
      submitted_at: new Date().toISOString(),
      note: "Bing accepted the submission. The next get_bing_sitemaps call may take 60 min to reflect it (Bing caches sitemap status for an hour).",
    });
  } catch (error) {
    if (error instanceof BingConfigError) {
      return NextResponse.json(
        { success: false, error: "bing_config", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof BingApiError) {
      return NextResponse.json(
        { success: false, error: "bing_api", status: error.status, message: error.detail },
        { status: 502 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

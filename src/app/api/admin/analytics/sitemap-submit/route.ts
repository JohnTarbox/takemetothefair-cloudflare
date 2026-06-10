export const dynamic = "force-dynamic";
/**
 * Resubmits a sitemap URL to Google Search Console — triggers a recrawl
 * signal ahead of Google's default multi-day cadence. Pairs naturally with
 * the post-bulk-ingest workflow (large import → resubmit affected child
 * sitemap → Google sees changes within hours).
 *
 * Auth: admin session OR X-Internal-Key header (the MCP server uses the
 * latter to invoke this from `resubmit_sitemap`).
 *
 * Requires the GSC service account to have Owner-level standing on the
 * configured `SC_SITE_URL` property AND the `webmasters` (not .readonly)
 * OAuth scope — both are handled inside `submitSitemap()`.
 */
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { ScApiError, ScConfigError, submitSitemap, type ScEnv } from "@/lib/search-console";

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

  const env = getCloudflareEnv() as unknown as ScEnv;
  try {
    const result = await submitSitemap(env, sitemapUrl);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ScConfigError) {
      // Bad input or missing/misconfigured property — caller's problem.
      return NextResponse.json(
        { success: false, error: "sc_config", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof ScApiError) {
      // Upstream GSC rejection — pass through the status so the MCP caller
      // can render a meaningful message (most commonly 403 if the service
      // account lacks Owner standing, 404 if the property is wrong).
      return NextResponse.json(
        { success: false, error: "sc_api", status: error.status, message: error.detail },
        { status: 502 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

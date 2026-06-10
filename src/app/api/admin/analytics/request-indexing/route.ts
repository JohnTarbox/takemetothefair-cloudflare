export const dynamic = "force-dynamic";
/**
 * Notify Google's Indexing API that a URL has changed — nudges Google to
 * recrawl the page ahead of its default queue cadence. Used by the
 * `request_indexing` MCP tool for high-value pages stuck in "Discovered –
 * currently not indexed" or just-renamed slugs.
 *
 * Auth: admin session OR X-Internal-Key header (the MCP server uses the
 * latter to invoke this from `request_indexing`).
 *
 * Requires the `indexing` OAuth scope (orthogonal to `webmasters`) AND the
 * service account to have Owner-level standing on the configured
 * `SC_SITE_URL` property. Both are handled inside `requestIndexing()`.
 */
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareEnv } from "@/lib/cloudflare";
import {
  ScApiError,
  ScConfigError,
  requestIndexing,
  type ScEnv,
  type RequestIndexingType,
} from "@/lib/search-console";

type PostBody = { url?: unknown; type?: unknown };

const VALID_TYPES: readonly RequestIndexingType[] = ["URL_UPDATED", "URL_DELETED"];

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

  const targetUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!targetUrl) {
    return NextResponse.json(
      {
        success: false,
        error: "missing_url",
        message: "Body must include `url` (string).",
      },
      { status: 400 }
    );
  }

  const type: RequestIndexingType =
    typeof body.type === "string" && (VALID_TYPES as readonly string[]).includes(body.type)
      ? (body.type as RequestIndexingType)
      : "URL_UPDATED";

  const env = getCloudflareEnv() as unknown as ScEnv;
  try {
    const result = await requestIndexing(env, targetUrl, type);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ScConfigError) {
      return NextResponse.json(
        { success: false, error: "sc_config", message: error.message },
        { status: 400 }
      );
    }
    if (error instanceof ScApiError) {
      // Upstream Indexing API rejection — pass through the status so the
      // MCP caller can render a meaningful message. Common cases: 403 if
      // the service account lacks Owner standing on the property, 429 if
      // Google is rate-limiting (the Indexing API has a per-project quota
      // of 200/day for most accounts), 404 if the URL is malformed.
      return NextResponse.json(
        { success: false, error: "sc_api", status: error.status, message: error.detail },
        { status: 502 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}

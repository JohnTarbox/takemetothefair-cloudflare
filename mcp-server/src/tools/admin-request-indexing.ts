/**
 * `request_indexing` admin MCP tool.
 *
 * Notifies Google's Indexing API that a URL has been updated (or deleted) —
 * nudges Google's crawl queue ahead of its default cadence. Use sparingly on
 * high-value pages: blog posts stuck in "Discovered – currently not indexed"
 * for an extended period, just-renamed slugs that need recrawl, or
 * just-published content where the multi-day default lag matters.
 *
 * Architecture: thin shell over a POST to the main app's
 * `/api/admin/analytics/request-indexing` endpoint (authenticated via
 * `X-Internal-Key`). The actual Google API call lives in main-app code so
 * the Google service-account credentials don't have to be duplicated into
 * the MCP server's environment.
 *
 * Permission requirements (already in place):
 *   1. `indexing` OAuth scope — handled in main app via `INDEXING_SCOPE`
 *      constant; no env-var change needed. The scope is orthogonal to
 *      `webmasters` (which sitemap submit uses), so a separate token cache
 *      key keeps the two from colliding at the Google OAuth layer.
 *   2. Service account must have Owner-level standing on the GSC property.
 *      Inferred to already exist because the daily URL-Inspection sweep
 *      (which also requires Owner) has been writing valid verdicts to
 *      `gsc_inspection_state`.
 *
 * Quota & expectations:
 *   - Default Google quota is 200 publish requests per day per project.
 *     The tool surfaces 429 from the API verbatim; if you hit it, back off.
 *   - Google officially restricts the Indexing API to `JobPosting` and
 *     `BroadcastEvent` schemas. The API empirically accepts and processes
 *     other URL types as recrawl signals — but Google may rate-limit or
 *     no-op such requests at any time. Don't bulk-submit; use for stuck
 *     individual URLs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

type RequestIndexingResponse = {
  success: boolean;
  url?: string;
  type?: "URL_UPDATED" | "URL_DELETED";
  notifyTime?: string | null;
  submittedAt?: string;
  error?: string;
  status?: number;
  message?: string;
};

export function registerRequestIndexingTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "request_indexing",
    "Ask Google's Indexing API to recrawl a single URL. Use sparingly on high-value pages stuck in 'Discovered – currently not indexed' or freshly-renamed slugs — do NOT bulk-submit. Google officially scopes this API to JobPosting and BroadcastEvent schemas; other URL types are accepted empirically as recrawl signals but may be rate-limited or no-op'd at any time. URL must belong to the configured GSC property (meetmeatthefair.com). Default daily quota is 200 publishes per project. Logs to admin_actions with action='indexing.request'. Admin only.",
    {
      url: z
        .string()
        .url()
        .describe(
          "Full URL to notify. Must be on the configured GSC property (meetmeatthefair.com). Example: 'https://meetmeatthefair.com/blog/some-stuck-post'."
        ),
      type: z
        .enum(["URL_UPDATED", "URL_DELETED"])
        .optional()
        .describe(
          "Notification type. URL_UPDATED (default) signals new or changed content. URL_DELETED signals the URL is gone and should be removed from the index."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "config",
              message:
                "request_indexing requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
            }),
          ],
          isError: true,
        };
      }

      const proxyUrl = `${env.MAIN_APP_URL}/api/admin/analytics/request-indexing`;
      const startedAt = new Date();
      const type = params.type ?? "URL_UPDATED";

      let response: Response;
      try {
        response = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            "X-Internal-Key": env.INTERNAL_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: params.url, type }),
        });
      } catch (e) {
        return {
          content: [
            jsonContent({
              error: "fetch_failed",
              message: `Failed to reach main app: ${e instanceof Error ? e.message : String(e)}`,
            }),
          ],
          isError: true,
        };
      }

      let parsed: RequestIndexingResponse;
      try {
        parsed = (await response.json()) as RequestIndexingResponse;
      } catch {
        return {
          content: [
            jsonContent({
              error: "bad_response",
              status: response.status,
              message: "Main app returned a non-JSON response.",
            }),
          ],
          isError: true,
        };
      }

      // Audit-log every invocation — both successes and failures — because
      // the failure mode is "we asked Google to recrawl and it didn't,"
      // which has no other visible side effect and would otherwise leave
      // no trace.
      await db.insert(adminActions).values({
        action: "indexing.request",
        actorUserId: auth.userId,
        targetType: "url",
        targetId: params.url,
        payloadJson: JSON.stringify({
          url: params.url,
          type,
          http_status: response.status,
          ok: parsed.success === true,
          error: parsed.error ?? null,
          message: parsed.message ?? null,
          notify_time: parsed.notifyTime ?? null,
          submitted_at: parsed.submittedAt ?? startedAt.toISOString(),
        }),
        createdAt: new Date(),
      });

      if (!parsed.success) {
        return {
          content: [
            jsonContent({
              error: parsed.error ?? "unknown",
              status: parsed.status ?? response.status,
              message: parsed.message ?? `HTTP ${response.status}`,
            }),
          ],
          isError: true,
        };
      }

      return {
        content: [
          jsonContent({
            success: true,
            url: parsed.url ?? params.url,
            type: parsed.type ?? type,
            notify_time: parsed.notifyTime,
            submitted_at: parsed.submittedAt,
            note: "Google accepted the notification. Recrawl is typically within hours but not guaranteed; check GSC URL Inspection in 24–48h to see if the verdict changed.",
          }),
        ],
      };
    }
  );
}

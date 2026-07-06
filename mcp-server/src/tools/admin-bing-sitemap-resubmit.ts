/**
 * `resubmit_bing_sitemap` admin MCP tool (OPE-109).
 *
 * The Bing counterpart to `resubmit_sitemap` (which targets Google Search
 * Console). Tells Bing Webmaster Tools to (re-)fetch a sitemap URL via its
 * SubmitFeed endpoint — needed to get per-child-sitemap tracking in Bing (the
 * sitemap index alone doesn't split submitted/crawled counts by content type).
 *
 * Architecture: a thin shell over a POST to the main app's
 * `/api/admin/analytics/bing-sitemap-submit` endpoint (authenticated via
 * `X-Internal-Key`). The actual Bing API call lives in main-app code because the
 * `BING_WEBMASTER_API_KEY` secret only exists in the Cloudflare Worker env — there
 * is no local path (the endpoint is deploy-only), and duplicating the secret into
 * the MCP server is avoided.
 *
 * Logs to admin_actions with action='sitemap.resubmit.bing'.
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

type SubmitResponse = {
  success: boolean;
  sitemap_url?: string;
  submitted_at?: string;
  error?: string;
  status?: number;
  message?: string;
};

export function registerBingSitemapResubmitTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "resubmit_bing_sitemap",
    "Ask Bing Webmaster Tools to (re-)fetch a sitemap URL via SubmitFeed. The Bing counterpart to resubmit_sitemap (Google). Use to get per-child-sitemap tracking in Bing or to nudge a recrawl after a bulk ingestion run. The URL must belong to the configured property (on meetmeatthefair.com). Logs to admin_actions with action='sitemap.resubmit.bing'. Admin only.",
    {
      sitemap_url: z
        .string()
        .url()
        .describe(
          "Full sitemap URL to submit to Bing. Must be on meetmeatthefair.com. Example: 'https://meetmeatthefair.com/sitemap-vendors.xml'."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "config",
              message:
                "resubmit_bing_sitemap requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
            }),
          ],
          isError: true,
        };
      }

      const url = `${env.MAIN_APP_URL}/api/admin/analytics/bing-sitemap-submit`;
      const startedAt = new Date();

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "X-Internal-Key": env.INTERNAL_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sitemap_url: params.sitemap_url }),
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

      let parsed: SubmitResponse;
      try {
        parsed = (await response.json()) as SubmitResponse;
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

      // Audit-log every invocation (success + failure) — the failure mode is
      // "we asked Bing to recrawl and it didn't," which leaves no other trace.
      await db.insert(adminActions).values({
        action: "sitemap.resubmit.bing",
        actorUserId: auth.userId,
        targetType: "sitemap",
        targetId: params.sitemap_url,
        payloadJson: JSON.stringify({
          sitemap_url: params.sitemap_url,
          http_status: response.status,
          ok: parsed.success === true,
          error: parsed.error ?? null,
          message: parsed.message ?? null,
          submitted_at: parsed.submitted_at ?? startedAt.toISOString(),
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
            sitemap_url: parsed.sitemap_url ?? params.sitemap_url,
            submitted_at: parsed.submitted_at,
            note: "Bing accepted the submission. get_bing_sitemaps may take ~60 min to reflect it (Bing caches sitemap status hourly).",
          }),
        ],
      };
    }
  );
}

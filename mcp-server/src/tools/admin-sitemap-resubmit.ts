/**
 * `resubmit_sitemap` admin MCP tool.
 *
 * Tells Google Search Console to re-fetch a sitemap URL — useful after a
 * bulk ingestion run that added many new entity pages. Google's default
 * recrawl cadence is multi-day; this signal typically triggers a re-fetch
 * within hours.
 *
 * Architecture: the tool itself is a thin shell over a POST to the main
 * app's `/api/admin/analytics/sitemap-submit` endpoint (authenticated via
 * `X-Internal-Key`). The actual GSC API call lives in main-app code so the
 * Google service-account credentials don't have to be duplicated into the
 * MCP server's environment.
 *
 * Bing is intentionally not supported in v1: the Bing Webmaster API
 * wrapper in this repo (`src/lib/bing-webmaster.ts`) has no submit
 * endpoint, and IndexNow is for content URLs rather than sitemap files.
 *
 * Permission requirements (verified before merge):
 *   1. `webmasters` (full) OAuth scope — handled in main app via
 *      `SC_WRITE_SCOPE` constant; no env-var change needed.
 *   2. Service account must have Owner-level standing on the GSC property.
 *      Inferred to already exist because the daily URL-Inspection sweep
 *      (which also requires Owner) has been writing 50 rows to
 *      `gsc_inspection_state` with valid verdicts as recently as today.
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
  siteUrl?: string;
  feedpath?: string;
  submittedAt?: string;
  error?: string;
  status?: number;
  message?: string;
};

export function registerSitemapResubmitTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "resubmit_sitemap",
    "Ask Google Search Console to re-fetch a sitemap URL. Use after a bulk ingestion run to nudge Google's recrawl ahead of the default multi-day cadence. The URL must belong to the configured GSC property (i.e. on meetmeatthefair.com). Logs to admin_actions with action='sitemap.resubmit'. Admin only. Google only — Bing has no equivalent submit endpoint in this repo's integration.",
    {
      sitemap_url: z
        .string()
        .url()
        .describe(
          "Full sitemap URL to resubmit. Must be on the configured GSC property (meetmeatthefair.com). Example: 'https://meetmeatthefair.com/sitemap-events.xml'."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "config",
              message:
                "resubmit_sitemap requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
            }),
          ],
          isError: true,
        };
      }

      const url = `${env.MAIN_APP_URL}/api/admin/analytics/sitemap-submit`;
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

      // Audit-log every invocation — both successes and failures — because
      // the failure mode here is "we asked GSC to recrawl and it didn't,"
      // which has no other visible side effect and would otherwise leave
      // no trace.
      await db.insert(adminActions).values({
        action: "sitemap.resubmit",
        actorUserId: auth.userId,
        targetType: "sitemap",
        targetId: params.sitemap_url,
        payloadJson: JSON.stringify({
          sitemap_url: params.sitemap_url,
          http_status: response.status,
          ok: parsed.success === true,
          error: parsed.error ?? null,
          message: parsed.message ?? null,
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
            sitemap_url: params.sitemap_url,
            site_url: parsed.siteUrl,
            submitted_at: parsed.submittedAt,
            note: "GSC accepted the submission. Recrawl is typically within hours but not guaranteed; check sitemap status in GSC for processing state.",
          }),
        ],
      };
    }
  );
}

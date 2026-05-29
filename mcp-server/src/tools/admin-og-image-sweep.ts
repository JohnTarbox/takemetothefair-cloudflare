/**
 * `trigger_og_image_sweep` admin MCP tool.
 *
 * Thin wrapper over `POST /api/admin/og-image/sweep` on the main app.
 * Mirrors the dry-run / apply controls at `/admin/og-image-sweep` so the
 * sweep can run from a Claude conversation without driving a browser.
 *
 * Analyst F1 (2026-05-29 backlog). Phase 2a of the og:image sweep
 * shipped 2026-05-26 (PRs #248, #251, #255 loop-marker fix); MCP exposure
 * was the analyst's remaining ask so the sweep can fold into per-source
 * triage chats ("for source X, run dry, show outcomes").
 *
 * Budget note: the underlying endpoint caps `limit` at 10 to stay inside
 * Cloudflare's 30s response budget; the wrapper exposes the same cap.
 * For larger sweeps, call repeatedly — the `og_image_sweep_attempted_at`
 * marker (drizzle/0092) ensures each call advances past already-tried
 * rows even when they skip on quality gates.
 *
 * Auth: ADMIN only at the MCP layer; underlying endpoint also accepts
 * X-Internal-Key which the wrapper forwards.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

interface SweepEventOutcome {
  event_id: string;
  source_url: string;
  outcome: string;
  image_url?: string;
  reason?: string;
}

interface SweepResponse {
  success?: boolean;
  apply?: boolean;
  limit?: number;
  candidates_considered?: number;
  outcomes?: SweepEventOutcome[];
  error?: string;
}

export function registerOgImageSweepTool(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "trigger_og_image_sweep",
    "Run the og:image sweep that fills events.image_url for imageless APPROVED events. With apply=false (default) returns the dry-run yield report — which candidate image each event would get, plus the per-event outcome (updated / would_update / skipped_*). With apply=true, downloads each accepted candidate to R2 and writes the image_url. Capped at 10 events per call by the 30s Cloudflare response budget; call repeatedly for larger batches — the og_image_sweep_attempted_at marker (drizzle/0092) advances past previously-tried rows on every call. Admin only.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe(
          "Max candidate events to process this call (default 5, hard cap 10). Each event = 1 source-URL fetch + 1 image HEAD + 1 image GET. Lower if upstream sources are slow."
        ),
      apply: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "false (default) = dry run, return what WOULD update without writing. true = download accepted candidates to R2 and persist image_url. Always start with apply=false to sanity-check the picked images."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            jsonContent({
              error: "config",
              message:
                "trigger_og_image_sweep requires MAIN_APP_URL and INTERNAL_API_KEY in the MCP server environment.",
            }),
          ],
          isError: true,
        };
      }

      const url = new URL(`${env.MAIN_APP_URL}/api/admin/og-image/sweep`);
      url.searchParams.set("limit", String(params.limit));
      url.searchParams.set("apply", params.apply ? "true" : "false");

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "X-Internal-Key": env.INTERNAL_API_KEY,
            "Content-Type": "application/json",
          },
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

      let parsed: SweepResponse;
      try {
        parsed = (await response.json()) as SweepResponse;
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

      if (!response.ok) {
        return {
          content: [
            jsonContent({
              error: parsed.error ?? "unknown",
              status: response.status,
              message: parsed.error ?? `HTTP ${response.status}`,
            }),
          ],
          isError: true,
        };
      }

      const outcomes = parsed.outcomes ?? [];
      // Roll up the per-event outcomes into a quick summary so callers
      // don't have to count rows themselves; the full array is still
      // returned for drill-down. Mirrors what the dashboard renders.
      const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.outcome] = (acc[o.outcome] ?? 0) + 1;
        return acc;
      }, {});

      return {
        content: [
          jsonContent({
            success: parsed.success ?? true,
            apply: parsed.apply ?? params.apply,
            limit: parsed.limit ?? params.limit,
            candidates_considered: parsed.candidates_considered ?? outcomes.length,
            summary,
            outcomes,
          }),
        ],
      };
    }
  );
}

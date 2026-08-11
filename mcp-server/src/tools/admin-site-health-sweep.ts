/**
 * `run_site_health_sweep` admin MCP tool (OPE-373, John-approved 2026-08-11).
 *
 * Thin wrapper over `POST /api/admin/site-health/sweep` on the main app.
 *
 * Why it exists: that endpoint accepts only an admin browser session or
 * `X-Internal-Key`, and an agent session holds neither. So the sweep — the
 * thing that opens, re-verifies, expires and closes every `health_issues` row
 * — could be inspected but never *run* from a conversation. That gap cost
 * OPE-372 its final acceptance criterion: the fix shipped and deployed, and
 * confirming it on the served surface had to wait for the next 06:00Z cron,
 * purely because nothing could trigger a run.
 *
 * Same lesson as OPE-348's fire drill, which shipped behind a credential
 * nobody held: a mechanism you cannot exercise on demand is a mechanism you
 * find out about during the incident.
 *
 * Budget note: each inspected URL is a GSC API call at ~3-5s, and OPE-373 adds
 * live re-verification fetches on top, so a large `batch_size` will exceed
 * Cloudflare's response budget. The maintenance passes (withdraw / re-verify /
 * expire) run BEFORE the inspection loop, so even a call that times out mid-
 * inspection has already committed its cleanup — but prefer small batches.
 *
 * Auth: ADMIN only at the MCP layer; forwards X-Internal-Key downstream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerSiteHealthSweepTool(
  server: McpServer,
  auth: AuthContext,
  env?: MainAppEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "run_site_health_sweep",
    [
      "Run the GSC site-health sweep on demand instead of waiting for the 06:00Z cron.",
      "",
      "Each run does four things: withdraws health_issues rows raised against non-canonical",
      "URLs (OPE-372), re-verifies open rows against the LIVE page for the classes our own",
      "server can settle — noindex / 5xx / 404 (OPE-373), expires rows the scan has stopped",
      "observing, and then inspects a batch of URLs via the Google URL Inspection API.",
      "",
      "The three maintenance passes run BEFORE the inspection loop, so they still complete",
      "even if the batch is cut short by quota or the response budget. Returns per-reason",
      "resolution counts, not just a total. Keep batch_size small — each inspected URL is a",
      "~3-5s GSC call against a ~2000/day quota. Admin only.",
    ].join(" "),
    {
      batch_size: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .default(8)
        .describe(
          "URLs to inspect via GSC this run (default 8). Pass 0 to run ONLY the maintenance passes — withdraw, re-verify, expire — with no GSC quota spend at all."
        ),
    },
    async ({ batch_size }) => {
      let response: Response;
      try {
        response = await mainAppFetch(
          env ?? {},
          `/api/admin/site-health/sweep?batchSize=${batch_size}`,
          "fetch",
          { method: "POST" }
        );
      } catch (err) {
        return {
          content: [jsonContent({ ok: false, error: "transport", message: String(err) })],
          isError: true,
        };
      }
      const payload = await response.json().catch(() => ({ error: "unparseable_response" }));
      return response.ok
        ? { content: [jsonContent(payload)] }
        : { content: [jsonContent({ status: response.status, body: payload })], isError: true };
    }
  );
}

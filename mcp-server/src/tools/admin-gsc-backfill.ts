/**
 * OPE-345 — `backfill_gsc_daily_totals`.
 *
 * The property-totals table needs filling back as far as GSC retains (~16
 * months), and the daily sync only covers a trailing week. This drives that
 * one-shot, and stays available afterwards as the repair control for any gap
 * the A6 freshness probe reports.
 *
 * Always sends `totals_only`, so the 16-month window does NOT drag the
 * (query, page) store along — that would be ~950k rows for data already
 * present, and a fast route to D1 limits.
 *
 * Idempotent by construction: the write is an upsert keyed on (site_url, date),
 * so re-running a window overwrites rather than duplicating. Safe to retry, and
 * safe to run in overlapping chunks.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerGscBackfillTools(server: McpServer, auth: AuthContext, env?: MainAppEnv) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "backfill_gsc_daily_totals",
    [
      "OPE-345 — fill gsc_daily_totals for a date window from GSC's un-dimensioned",
      "(date-only) Search Analytics response.",
      "",
      "This table exists because gsc_search_metrics CANNOT be summed to property totals:",
      "it is dimensioned by (query, page), and GSC omits anonymized and long-tail rows,",
      "which for July 2026 meant 3,305 clicks against Google's own 9,370 — a 64.7%",
      "undercount that no amount of syncing fixes.",
      "",
      "Idempotent (upsert on site_url+date), so re-running a window is safe. Sends",
      "totals_only, so it will not re-pull the dimensioned store. Admin only.",
    ].join(" "),
    {
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Inclusive YYYY-MM-DD start. GSC retains ~16 months; earlier returns nothing."),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Inclusive YYYY-MM-DD end. GSC data lags ~3 days."),
    },
    async ({ start_date, end_date }) => {
      let response: Response;
      try {
        response = await mainAppFetch(env ?? {}, "/api/admin/analytics/gsc-metrics/sync", "fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_date,
            end_date,
            totals_only: true,
            skip_ga4: true,
            skip_bing: true,
          }),
        });
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

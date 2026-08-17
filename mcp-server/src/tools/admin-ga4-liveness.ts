/**
 * OPE-386 — `get_ga4_liveness`: read the GA4 data-age liveness state.
 *
 * The gap this closes: OPE-381 shipped a liveness check that writes a row to
 * `ga4_liveness_log` on every run, and **no MCP tool could read it**. Its
 * acceptance criterion — the 06:00Z run records `status='green'` with
 * `consecutive_failures=0` — could only be confirmed by a developer D1 query.
 *
 * A check whose result is unobservable from the surface operators actually use
 * is only half-built: it can go red without anyone finding out, which is the
 * same silence class the check exists to prevent. (`get_data_health_report`,
 * `get_site_health_issues`, `record_agent_heartbeat` and `get_ga4_event_detail`
 * were all checked during that recheck; none expose this table.)
 *
 * Read-only and admin-gated, matching the other health-report tools. There is
 * deliberately no mutation path: the row is written by the liveness cron, and a
 * tool that could edit it would let an operator "fix" a red state by rewriting
 * the evidence.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { ga4LivenessLog } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** Cap on returned history. Trend checks need a handful of rows, not a dump. */
const MAX_LIMIT = 50;

/** Mirrors the `status` column's declared union in packages/db-schema. */
const GA4_LIVENESS_STATUSES = ["green", "degraded", "critical"] as const;

export function registerGa4LivenessTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_ga4_liveness",
    "Read the GA4 data-age liveness state from ga4_liveness_log (OPE-381's check). " +
      "Returns the newest row by default — status, consecutive_failures, data_age_seconds, " +
      "max_data_date, checked_at, alert_fired — or recent history with `limit`. Read-only, admin only.",
    {
      limit: z
        .number()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`How many recent rows to return, newest first (default 1, max ${MAX_LIMIT}).`),
      // Enum, not free text: the column is typed `green | degraded | critical`,
      // so a string param would let a caller filter on a value that can never
      // match and read the empty result as "healthy". (The ticket guessed
      // 'green'/'red'; the real third state is `degraded`.)
      status: z
        .enum(GA4_LIVENESS_STATUSES)
        .optional()
        .describe("Optional filter. Omit for all statuses."),
    },
    async (params) => {
      const limit = params.limit ?? 1;

      const base = db
        .select({
          id: ga4LivenessLog.id,
          checked_at: ga4LivenessLog.checkedAt,
          status: ga4LivenessLog.status,
          max_data_date: ga4LivenessLog.maxDataDate,
          data_age_seconds: ga4LivenessLog.dataAgeSeconds,
          consecutive_failures: ga4LivenessLog.consecutiveFailures,
          alert_fired: ga4LivenessLog.alertFired,
        })
        .from(ga4LivenessLog)
        .$dynamic();

      if (params.status) base.where(eq(ga4LivenessLog.status, params.status));

      const rows = await base.orderBy(desc(ga4LivenessLog.checkedAt)).limit(limit);

      // An empty table is a real finding, not an empty result: it means the
      // liveness cron has never written a row, which is exactly the "shipped
      // but silently not executing" case. Say so rather than returning [].
      if (rows.length === 0) {
        return {
          content: [
            jsonContent({
              rows: [],
              note: params.status
                ? `No ga4_liveness_log rows with status='${params.status}'.`
                : "ga4_liveness_log is EMPTY — the liveness check has never recorded a run. " +
                  "That is a finding in itself: the check may not be executing.",
            }),
          ],
        };
      }

      const newest = rows[0];
      return {
        content: [
          jsonContent({
            newest: {
              ...newest,
              // Serialise the timestamp explicitly — the column is
              // mode:"timestamp", so Drizzle hands back a Date that would
              // otherwise render as an opaque JSON string.
              checked_at: newest.checked_at ? new Date(newest.checked_at).toISOString() : null,
              // Derived, so a reader doesn't have to do the arithmetic to
              // answer "is this stale?" — the whole point of the check.
              data_age_hours:
                newest.data_age_seconds != null
                  ? Math.round((Number(newest.data_age_seconds) / 3600) * 10) / 10
                  : null,
            },
            rows: rows.map((r) => ({
              ...r,
              checked_at: r.checked_at ? new Date(r.checked_at).toISOString() : null,
            })),
            returned: rows.length,
          }),
        ],
      };
    }
  );
}

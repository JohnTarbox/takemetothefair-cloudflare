/**
 * UR1 C5 (2026-06-04) — MCP tools for problem-report triage.
 *
 * Four tools, all admin-only:
 *   - list_problem_reports — paginated list with severity/resolved filters
 *   - get_problem_report — single row + linked inbound_email + correlated errors
 *   - resolve_problem_report — set resolved_at / notes
 *   - correlate_problem_report — re-run burst-watch against current error_logs
 *     (useful for web-form reports which skipped intake-time correlation, and
 *      for late-arriving error log rows on email-source reports)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { problemReports, errorLogs, inboundEmails, users, adminActions } from "../schema.js";
import type { Db } from "../db.js";
import { jsonContent } from "../helpers.js";
import { getErrorLogsBurstWindow } from "../error-logs-burst.js";
import { HIGH_THRESHOLD, LOOKBACK_MINUTES, LOOKAHEAD_MINUTES } from "../problem-reports/intake.js";

export function registerAdminProblemReportTools(server: McpServer, db: Db) {
  // ── list_problem_reports ────────────────────────────────────────
  server.tool(
    "list_problem_reports",
    "List user-submitted problem reports. Defaults to open + any-severity, newest first.",
    {
      severity: z
        .enum(["HIGH", "LOW", "any"])
        .optional()
        .describe("Severity filter; 'any' = no filter."),
      source: z
        .enum(["web", "email", "any"])
        .optional()
        .describe("Source filter; 'any' = no filter."),
      resolved: z
        .enum(["true", "false", "any"])
        .optional()
        .describe("'false' = only open (default); 'true' = only resolved; 'any' = both."),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    },
    async (params) => {
      const limit = params.limit ?? 50;
      const conditions = [];
      const resolvedFilter = params.resolved ?? "false";
      if (resolvedFilter === "false") conditions.push(isNull(problemReports.resolvedAt));
      else if (resolvedFilter === "true") conditions.push(isNotNull(problemReports.resolvedAt));
      const severityFilter = params.severity ?? "any";
      if (severityFilter !== "any") conditions.push(eq(problemReports.severity, severityFilter));
      const sourceFilter = params.source ?? "any";
      if (sourceFilter !== "any") conditions.push(eq(problemReports.source, sourceFilter));

      const rows = await db
        .select()
        .from(problemReports)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(problemReports.createdAt))
        .limit(limit);

      return {
        content: [
          jsonContent({
            total: rows.length,
            reports: rows.map((r) => ({
              id: r.id,
              createdAt: r.createdAt.toISOString(),
              severity: r.severity,
              correlatedErrorCount: r.correlatedErrorCount,
              source: r.source,
              reporterEmail: r.reporterEmail,
              path: r.path,
              bodyExcerpt: r.body.slice(0, 200),
              resolved: r.resolvedAt !== null,
              resolvedAt: r.resolvedAt?.toISOString() ?? null,
              adminUrl: `https://meetmeatthefair.com/admin/problem-reports/${r.id}`,
            })),
          }),
        ],
      };
    }
  );

  // ── get_problem_report ──────────────────────────────────────────
  server.tool(
    "get_problem_report",
    "Fetch a single problem report by id, with linked inbound_email + correlated error_logs in the (-30m,+5m) window.",
    {
      id: z.string().min(1).describe("Problem-report id (uuid)."),
    },
    async (params) => {
      const [row] = await db
        .select()
        .from(problemReports)
        .where(eq(problemReports.id, params.id))
        .limit(1);
      if (!row) {
        return {
          content: [{ type: "text" as const, text: `No problem_report row with id=${params.id}.` }],
          isError: true,
        };
      }

      // Linked inbound email (if any).
      let inboundEmail: typeof inboundEmails.$inferSelect | null = null;
      if (row.inboundEmailId) {
        const [ie] = await db
          .select()
          .from(inboundEmails)
          .where(eq(inboundEmails.id, row.inboundEmailId))
          .limit(1);
        inboundEmail = ie ?? null;
      }

      // Errors in the correlation window.
      const since = new Date(row.createdAt.getTime() - LOOKBACK_MINUTES * 60_000);
      const until = new Date(row.createdAt.getTime() + LOOKAHEAD_MINUTES * 60_000);
      const errors = await db
        .select()
        .from(errorLogs)
        .where(
          and(
            gte(errorLogs.timestamp, since),
            lt(errorLogs.timestamp, until),
            eq(errorLogs.level, "error")
          )
        )
        .limit(50);

      return {
        content: [
          jsonContent({
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            severity: row.severity,
            correlatedErrorCount: row.correlatedErrorCount,
            source: row.source,
            reporterEmail: row.reporterEmail,
            path: row.path,
            userAgent: row.userAgent,
            body: row.body,
            inboundEmailId: row.inboundEmailId,
            resolved: row.resolvedAt !== null,
            resolvedAt: row.resolvedAt?.toISOString() ?? null,
            resolvedByUserId: row.resolvedByUserId,
            notes: row.notes,
            linkedInboundEmail: inboundEmail
              ? {
                  id: inboundEmail.id,
                  subject: inboundEmail.subject,
                  fromAddress: inboundEmail.fromAddress,
                  receivedAt: inboundEmail.receivedAt.toISOString(),
                }
              : null,
            correlationWindow: {
              since: since.toISOString(),
              until: until.toISOString(),
              errorsInWindow: errors.length,
              errors: errors.map((e) => ({
                id: e.id,
                timestamp: e.timestamp.toISOString(),
                source: e.source,
                message: e.message,
              })),
            },
            adminUrl: `https://meetmeatthefair.com/admin/problem-reports/${row.id}`,
          }),
        ],
      };
    }
  );

  // ── resolve_problem_report ──────────────────────────────────────
  server.tool(
    "resolve_problem_report",
    "Mark a problem report as resolved. Writes admin_actions audit row.",
    {
      id: z.string().min(1).describe("Problem-report id."),
      notes: z
        .string()
        .max(2000)
        .optional()
        .describe("What you did / why this is closed. Operator-side context."),
      resolved_by_email: z
        .string()
        .email()
        .optional()
        .describe("Admin user's email; used to look up resolved_by_user_id."),
    },
    async (params) => {
      const [existing] = await db
        .select()
        .from(problemReports)
        .where(eq(problemReports.id, params.id))
        .limit(1);
      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `No row id=${params.id}.` }],
          isError: true,
        };
      }
      if (existing.resolvedAt) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Already resolved at ${existing.resolvedAt.toISOString()}.`,
            },
          ],
          isError: true,
        };
      }

      let resolvedByUserId: string | null = null;
      if (params.resolved_by_email) {
        const [u] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, params.resolved_by_email))
          .limit(1);
        resolvedByUserId = u?.id ?? null;
      }

      await db
        .update(problemReports)
        .set({
          resolvedAt: new Date(),
          resolvedByUserId,
          notes: params.notes ?? null,
        })
        .where(eq(problemReports.id, params.id));

      // Audit.
      try {
        await db.insert(adminActions).values({
          id: crypto.randomUUID(),
          action: "problem_report.resolve",
          targetType: "problem_report",
          targetId: params.id,
          actorUserId: resolvedByUserId,
          metadata: JSON.stringify({
            notes: params.notes ?? null,
            resolverEmail: params.resolved_by_email ?? null,
          }),
          createdAt: new Date(),
        });
      } catch {
        // Audit failure shouldn't fail the resolve — log nothing further.
      }

      return {
        content: [jsonContent({ resolved: true, id: params.id })],
      };
    }
  );

  // ── correlate_problem_report ────────────────────────────────────
  server.tool(
    "correlate_problem_report",
    "Re-run the error_logs burst-watch correlation for a problem report. Useful for web-form reports (which skipped intake-time correlation) or to pick up late-arriving error_logs entries.",
    {
      id: z.string().min(1).describe("Problem-report id."),
      bump_severity: z
        .boolean()
        .optional()
        .describe(
          "When true (default), update severity=HIGH on the row if the re-correlation crosses the HIGH_THRESHOLD. False = report-only."
        ),
    },
    async (params) => {
      const [row] = await db
        .select()
        .from(problemReports)
        .where(eq(problemReports.id, params.id))
        .limit(1);
      if (!row) {
        return {
          content: [{ type: "text" as const, text: `No row id=${params.id}.` }],
          isError: true,
        };
      }

      const since = new Date(row.createdAt.getTime() - LOOKBACK_MINUTES * 60_000);
      const until = new Date(row.createdAt.getTime() + LOOKAHEAD_MINUTES * 60_000);
      const burst = await getErrorLogsBurstWindow(db, {
        since,
        until,
        minCount: HIGH_THRESHOLD,
        topSourcesLimit: 10,
      });

      const newSeverity: "LOW" | "HIGH" = burst.totalErrors >= HIGH_THRESHOLD ? "HIGH" : "LOW";
      const bumped = params.bump_severity !== false; // default true
      let mutated = false;
      if (
        bumped &&
        (burst.totalErrors !== row.correlatedErrorCount || newSeverity !== row.severity)
      ) {
        await db
          .update(problemReports)
          .set({
            severity: newSeverity,
            correlatedErrorCount: burst.totalErrors,
          })
          .where(eq(problemReports.id, params.id));
        mutated = true;
      }

      return {
        content: [
          jsonContent({
            id: row.id,
            previousSeverity: row.severity,
            previousCorrelatedErrorCount: row.correlatedErrorCount,
            newSeverity,
            newCorrelatedErrorCount: burst.totalErrors,
            crossed: burst.tripped,
            mutated,
            bySource: burst.bySource,
            window: { since: since.toISOString(), until: until.toISOString() },
          }),
        ],
      };
    }
  );

  // Also surface the count via a query-style helper (used by `whoami`-style
  // dashboards). Single ad-hoc call so an MCP user can poll "anything new?"
  server.tool(
    "get_problem_report_open_count",
    "Return the count of open (unresolved) problem reports, split by severity. Useful for at-a-glance polling.",
    {},
    async () => {
      const rows = await db
        .select({
          severity: problemReports.severity,
          count: sql<number>`count(*)`,
        })
        .from(problemReports)
        .where(isNull(problemReports.resolvedAt))
        .groupBy(problemReports.severity);
      const high = rows.find((r) => r.severity === "HIGH")?.count ?? 0;
      const low = rows.find((r) => r.severity === "LOW")?.count ?? 0;
      return {
        content: [jsonContent({ open: { high, low, total: high + low } })],
      };
    }
  );
}

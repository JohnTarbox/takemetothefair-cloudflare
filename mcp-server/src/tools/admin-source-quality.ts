/**
 * `get_source_quality` admin MCP tool.
 *
 * Returns the same per-source-domain × ingestion-method aggregation that
 * /admin/source-quality renders (introduced PR #252), so Claude can read
 * source signals in conversation without a browser hop.
 *
 * Analyst F1 (2026-05-29 backlog). Unlike the salvage + og:image-sweep
 * tools, no main-app endpoint backs this — the page runs the query
 * directly as a server component. The MCP server has its own D1 binding
 * over the same database, so the tool re-implements the query against
 * shared schema (packages/db-schema) rather than HTTP-roundtripping. If
 * /admin/source-quality is later refactored to fetch from a JSON API,
 * the two surfaces should switch to the same helper to prevent drift.
 *
 * Query parity with the page (`loadSourceQuality` in src/app/admin/
 * source-quality/page.tsx):
 *   - GROUP BY (source_domain, ingestion_method) on events
 *   - Aggregates: total, rejected, cancelled, gate_flagged, imageless
 *   - LEFT JOIN open event_date_drift_findings for unresolved_drift count
 *   - Filter ingestion_method IS NOT NULL (drops the pre-classification tail)
 *   - Filter total >= MIN_EVENTS_FOR_SCORING (default 3 — matches page)
 *   - Composite concern % = (rejected + cancelled + gate_flagged +
 *                            unresolved_drift) / total
 *
 * Admin only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { events, eventDateDriftFindings } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const SORT_VALUES = ["concern_desc", "imageless_desc", "total_desc"] as const;
type SortValue = (typeof SORT_VALUES)[number];

interface SourceRow {
  source_domain: string | null;
  ingestion_method: string | null;
  total: number;
  rejected: number;
  cancelled: number;
  gate_flagged: number;
  imageless: number;
  unresolved_drift: number;
  concern_pct: number;
}

function sortRows(rows: SourceRow[], sort: SortValue): SourceRow[] {
  // Stable tiebreaker on `total` keeps the same source pinned in place
  // when the primary key ties — matches what the page does.
  switch (sort) {
    case "imageless_desc":
      return [...rows].sort((a, b) => b.imageless - a.imageless || b.total - a.total);
    case "total_desc":
      return [...rows].sort((a, b) => b.total - a.total || b.concern_pct - a.concern_pct);
    case "concern_desc":
    default:
      return [...rows].sort((a, b) => b.concern_pct - a.concern_pct || b.total - a.total);
  }
}

export function registerSourceQualityTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_source_quality",
    "Per-source-domain × ingestion-method quality aggregation, the same data /admin/source-quality renders. Distinguishes 'low-quality source' (high rejection / drift / gate-flag rates) from 'failing extractor on a good source' by surfacing ingestion_method alongside source_domain. Use to triage which sources to deprioritize or which extractor paths to investigate. Returns one row per (source_domain, ingestion_method) pair with at least min_events events. Admin only.",
    {
      min_events: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe(
          "Drop sources with fewer than this many total events — they're too small to score meaningfully. Default 3 matches the page."
        ),
      ingestion_method: z
        .string()
        .optional()
        .describe(
          "Filter to a single ingestion method (e.g. 'direct_scrape', 'aggregator_import', 'email_submission', 'vendor_submission', 'community_suggestion', 'admin_manual', 'web_research'). Omit to return all methods."
        ),
      sort: z
        .enum(SORT_VALUES)
        .optional()
        .default("concern_desc")
        .describe(
          "Sort order. concern_desc (default) = worst quality first; imageless_desc = highest imageless rate first; total_desc = highest-volume sources first."
        ),
    },
    async (params) => {
      // Aggregate pass 1: counts per (source_domain, ingestion_method).
      // SQLite CASE-WHEN sums in one pass are cheaper than 5 separate
      // queries; the GROUP BY cardinality is small (<300 in practice).
      const baseRows = await db
        .select({
          sourceDomain: events.sourceDomain,
          ingestionMethod: events.ingestionMethod,
          total: sql<number>`COUNT(*)`,
          rejected: sql<number>`SUM(CASE WHEN ${events.status} = 'REJECTED' THEN 1 ELSE 0 END)`,
          cancelled: sql<number>`SUM(CASE WHEN ${events.status} = 'CANCELLED' THEN 1 ELSE 0 END)`,
          gateFlagged: sql<number>`SUM(CASE WHEN ${events.status} = 'PENDING' AND ${events.gateFlags} IS NOT NULL THEN 1 ELSE 0 END)`,
          imageless: sql<number>`SUM(CASE WHEN ${events.imageUrl} IS NULL OR ${events.imageUrl} = '' THEN 1 ELSE 0 END)`,
        })
        .from(events)
        .where(isNotNull(events.ingestionMethod))
        .groupBy(events.sourceDomain, events.ingestionMethod);

      // Pass 2: unresolved date-drift findings per group. Separate query
      // because joining would over-count events with multiple findings;
      // a subquery in the SELECT is awkward in Drizzle. Aggregate first,
      // merge in JS.
      const driftRows = await db
        .select({
          sourceDomain: events.sourceDomain,
          ingestionMethod: events.ingestionMethod,
          unresolvedDrift: sql<number>`COUNT(DISTINCT ${eventDateDriftFindings.eventId})`,
        })
        .from(eventDateDriftFindings)
        .innerJoin(events, eq(events.id, eventDateDriftFindings.eventId))
        .where(and(isNull(eventDateDriftFindings.resolvedAt), isNotNull(events.ingestionMethod)))
        .groupBy(events.sourceDomain, events.ingestionMethod);

      const driftByKey = new Map<string, number>();
      for (const r of driftRows) {
        const key = `${r.sourceDomain ?? ""}|${r.ingestionMethod ?? ""}`;
        driftByKey.set(key, r.unresolvedDrift ?? 0);
      }

      const minEvents = params.min_events ?? 3;
      const rows: SourceRow[] = baseRows
        .filter((r) => (r.total ?? 0) >= minEvents)
        .filter(
          (r) => params.ingestion_method == null || r.ingestionMethod === params.ingestion_method
        )
        .map((r) => {
          const key = `${r.sourceDomain ?? ""}|${r.ingestionMethod ?? ""}`;
          const total = r.total ?? 0;
          const rejected = r.rejected ?? 0;
          const cancelled = r.cancelled ?? 0;
          const gateFlagged = r.gateFlagged ?? 0;
          const unresolvedDrift = driftByKey.get(key) ?? 0;
          const concerns = rejected + cancelled + gateFlagged + unresolvedDrift;
          const concernPct = total > 0 ? Math.round((concerns / total) * 1000) / 10 : 0;
          return {
            source_domain: r.sourceDomain,
            ingestion_method: r.ingestionMethod,
            total,
            rejected,
            cancelled,
            gate_flagged: gateFlagged,
            imageless: r.imageless ?? 0,
            unresolved_drift: unresolvedDrift,
            concern_pct: concernPct,
          };
        });

      const sorted = sortRows(rows, params.sort ?? "concern_desc");

      // Overall rollup — mirrors loadOverall on the page. Same numbers
      // even when sort/filter changes, so the caller can see "X% of
      // events have a classified source" alongside the per-row table.
      const [{ totalEvents = 0 } = { totalEvents: 0 }] = await db
        .select({ totalEvents: sql<number>`COUNT(*)` })
        .from(events);
      const [{ classified = 0 } = { classified: 0 }] = await db
        .select({ classified: sql<number>`COUNT(*)` })
        .from(events)
        .where(isNotNull(events.ingestionMethod));
      const [{ sourcesTracked = 0 } = { sourcesTracked: 0 }] = await db
        .select({
          sourcesTracked: sql<number>`COUNT(DISTINCT ${events.sourceDomain})`,
        })
        .from(events)
        .where(isNotNull(events.sourceDomain));

      return {
        content: [
          jsonContent({
            overall: {
              total_events: totalEvents ?? 0,
              sources_tracked: sourcesTracked ?? 0,
              classified_pct:
                (totalEvents ?? 0) > 0
                  ? Math.round(((classified ?? 0) / (totalEvents ?? 1)) * 1000) / 10
                  : 0,
            },
            filters: {
              min_events: minEvents,
              ingestion_method: params.ingestion_method ?? null,
              sort: params.sort ?? "concern_desc",
            },
            row_count: sorted.length,
            rows: sorted,
          }),
        ],
      };
    }
  );
}

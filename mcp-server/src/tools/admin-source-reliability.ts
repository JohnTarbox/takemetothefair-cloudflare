/**
 * `get_source_reliability` admin MCP tool — surfaces the
 * `source_reliability` matrix that GW1c's Bayesian updater
 * accumulates.
 *
 * GW1c (analyst, 2026-06-02). Complements `get_source_quality` (PR
 * #252) which aggregates per-(source_domain × ingestion_method)
 * extraction/rejection health. Reliability is the orthogonal axis:
 * how often does the source's value actually MATCH the verified
 * truth, not just how often does it extract cleanly.
 *
 * Per B10 of the dev email — instead of folding into
 * get_source_quality, both tools return a `cross_link` field with the
 * matching `source_key` so operators can hop between dashboards.
 *
 * ## Filter modes
 *
 * - `source_key` set → return the per-(field_class × axis) matrix for
 *   that one source. Useful when triaging "is this source worth
 *   trusting on dates specifically."
 * - `field_class` + `axis` set → return the per-source leaderboard for
 *   that cell. Useful for "who are the worst offenders on date
 *   freshness."
 * - Neither set → return the worst-N rows across all cells, ordered by
 *   ascending score (most-unreliable first). Pagination via `limit`.
 *
 * Admin only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { sourceReliability } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const FIELD_CLASS_VALUES = [
  "date",
  "hours",
  "venue",
  "status",
  "price",
  "existence",
  "name",
] as const;

const AXIS_VALUES = ["accuracy", "freshness"] as const;

export function registerSourceReliabilityTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_source_reliability",
    "Per-source reliability matrix from the Goodwill Engine's Bayesian updater. Score is the posterior mean alpha/(alpha+beta) of the source's accuracy or freshness on a field class. confidence is one of prior_only / low / established based on n_checks. Three filter modes: pass source_key for one source's full matrix; pass field_class+axis for a per-source leaderboard on that cell; pass neither for the worst-N across all cells. Cross-link with get_source_quality via the source_key field. Admin only.",
    {
      source_key: z
        .string()
        .optional()
        .describe(
          "Filter to one source (lowercased source_domain, e.g. 'brattleboroareafarmersmarket.com')."
        ),
      field_class: z
        .enum(FIELD_CLASS_VALUES)
        .optional()
        .describe(
          "Filter by field class (date | hours | venue | status | price | existence | name)."
        ),
      axis: z.enum(AXIS_VALUES).optional().describe("Filter by axis (accuracy | freshness)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max rows returned (default 50)."),
    },
    async (params) => {
      const conditions = [];
      if (params.source_key) conditions.push(eq(sourceReliability.sourceKey, params.source_key));
      if (params.field_class) conditions.push(eq(sourceReliability.fieldClass, params.field_class));
      if (params.axis) conditions.push(eq(sourceReliability.axis, params.axis));

      const limit = params.limit ?? 50;

      const query = db
        .select({
          source_key: sourceReliability.sourceKey,
          field_class: sourceReliability.fieldClass,
          axis: sourceReliability.axis,
          prior_type: sourceReliability.priorType,
          alpha: sourceReliability.alpha,
          beta: sourceReliability.beta,
          n_checks: sourceReliability.nChecks,
          n_agreed: sourceReliability.nAgreed,
          n_stale: sourceReliability.nStale,
          score: sourceReliability.score,
          confidence: sourceReliability.confidence,
          model_version: sourceReliability.modelVersion,
          last_updated: sourceReliability.lastUpdated,
        })
        .from(sourceReliability)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(asc(sourceReliability.score))
        .limit(limit);

      const rows = await query;

      return {
        content: [
          jsonContent({
            count: rows.length,
            limit,
            filter: {
              source_key: params.source_key ?? null,
              field_class: params.field_class ?? null,
              axis: params.axis ?? null,
            },
            // B10 cross-link: every row carries the source_key so admins
            // can paste it into get_source_quality without re-typing.
            rows: rows.map((r) => ({
              ...r,
              cross_link: {
                tool: "get_source_quality",
                hint: `get_source_quality { source_domain: '${r.source_key}' }`,
              },
            })),
          }),
        ],
      };
    }
  );
}

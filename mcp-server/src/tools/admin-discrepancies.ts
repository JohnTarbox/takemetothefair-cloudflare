/**
 * GW1d admin MCP tools for the Goodwill Engine outreach queue.
 *
 *   list_event_discrepancies  — paginated queue read; ranks by
 *                               outreach_priority_score DESC
 *   resolve_discrepancy        — set status + resolved_value, then
 *                               fire the Bayesian updater (GW1c) to
 *                               score the involved sources
 *   create_discrepancy         — manual / agent capture path
 *
 * All three are admin-only. The MCP server's `registerAdminTools`
 * registers them in admin.ts.
 *
 * The queue ranker is in ../goodwill/queue-ranking.ts; the Bayesian
 * updater is in ../goodwill/scoring.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { eventDiscrepancies, adminActions } from "../schema.js";
import { jsonContent, sanitizeProse } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { updateReliability } from "../goodwill/scoring.js";
import { initialCaptureScore, rerankOpenQueueBatch } from "../goodwill/queue-ranking.js";

const FIELD_CLASS_VALUES = [
  "date",
  "hours",
  "venue",
  "status",
  "price",
  "existence",
  "name",
] as const;

const RESOLUTION_STATUS_VALUES = [
  "open",
  "resolved_authoritative",
  "resolved_divergent",
  "self_resolved",
  "dismissed",
] as const;

const RESOLUTION_SOURCE_VALUES = ["higher_tier", "post_event", "operator"] as const;

export function registerDiscrepancyTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  // ── list_event_discrepancies ────────────────────────────────────
  server.tool(
    "list_event_discrepancies",
    "Paginated read of the outreach queue. Filter by resolution_status (default 'open'), field_class, or divergent_source_key; sort by outreach_priority_score DESC. Returns the highest-leverage discrepancies first. Admin only.",
    {
      resolution_status: z
        .enum(RESOLUTION_STATUS_VALUES)
        .optional()
        .describe("Filter by resolution status. Defaults to 'open' (the queue)."),
      field_class: z.enum(FIELD_CLASS_VALUES).optional().describe("Filter by field class."),
      divergent_source_key: z
        .string()
        .optional()
        .describe("Filter by divergent_source_key (lowercased source_domain)."),
      outreach_candidates_only: z
        .boolean()
        .optional()
        .describe(
          "When true, only return rows where outreach_candidate=1 (priority above the GW1d threshold)."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max rows (default 50, max 200)."),
      offset: z.number().int().min(0).optional().default(0).describe("Pagination offset."),
    },
    async (params) => {
      const conditions = [
        eq(eventDiscrepancies.resolutionStatus, params.resolution_status ?? "open"),
      ];
      if (params.field_class)
        conditions.push(eq(eventDiscrepancies.fieldClass, params.field_class));
      if (params.divergent_source_key)
        conditions.push(eq(eventDiscrepancies.divergentSourceKey, params.divergent_source_key));
      if (params.outreach_candidates_only)
        conditions.push(eq(eventDiscrepancies.outreachCandidate, true));

      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const rows = await db
        .select()
        .from(eventDiscrepancies)
        .where(and(...conditions))
        .orderBy(
          desc(eventDiscrepancies.outreachPriorityScore),
          desc(eventDiscrepancies.detectedAt)
        )
        .limit(limit)
        .offset(offset);

      return {
        content: [
          jsonContent({
            count: rows.length,
            limit,
            offset,
            filter: {
              resolution_status: params.resolution_status ?? "open",
              field_class: params.field_class ?? null,
              divergent_source_key: params.divergent_source_key ?? null,
              outreach_candidates_only: params.outreach_candidates_only ?? false,
            },
            rows,
          }),
        ],
      };
    }
  );

  // ── resolve_discrepancy ─────────────────────────────────────────
  server.tool(
    "resolve_discrepancy",
    "Set a discrepancy's resolution_status, resolved_value, and resolution_source. Fires the Bayesian updater (updateReliability) to adjust source_reliability scores for the involved sources. Idempotent — re-resolving a row that's already non-open is a no-op for the score update path. Admin only.",
    {
      discrepancy_id: z.string().describe("event_discrepancies.id"),
      resolution_status: z
        .enum(["resolved_authoritative", "resolved_divergent", "self_resolved", "dismissed"])
        .describe(
          "Which side won. 'self_resolved' = the row's own update made the discrepancy moot (e.g. operator fixed the field directly); 'dismissed' = the discrepancy was a format-only or operator-misread, no scoring signal."
        ),
      resolved_value: z
        .string()
        .max(1000)
        .transform(sanitizeProse)
        .optional()
        .describe("Ground truth once known. Optional — 'dismissed' resolutions skip this."),
      resolution_source: z
        .enum(RESOLUTION_SOURCE_VALUES)
        .optional()
        .describe(
          "Where the resolution came from. 'higher_tier' triggers the circularity guard in updateReliability — see goodwill/scoring.ts. Optional but recommended."
        ),
      notes: z
        .string()
        .max(1000)
        .transform(sanitizeProse)
        .optional()
        .describe("Optional operator note appended to the discrepancy row."),
    },
    async (params) => {
      const existing = await db
        .select()
        .from(eventDiscrepancies)
        .where(eq(eventDiscrepancies.id, params.discrepancy_id))
        .limit(1);
      if (existing.length === 0) {
        return {
          content: [{ type: "text", text: `discrepancy not found: ${params.discrepancy_id}` }],
          isError: true,
        };
      }
      const wasOpen = existing[0].resolutionStatus === "open";

      await db
        .update(eventDiscrepancies)
        .set({
          resolutionStatus: params.resolution_status,
          resolvedValue: params.resolved_value ?? null,
          resolutionSource: params.resolution_source ?? null,
          resolvedAt: new Date(),
          notes: params.notes ?? existing[0].notes,
        })
        .where(eq(eventDiscrepancies.id, params.discrepancy_id));

      // Trigger the Bayesian updater ONLY on the open → non-open
      // transition. Re-resolving an already-non-open row would
      // double-count the observation against source_reliability.
      let scoring: Awaited<ReturnType<typeof updateReliability>> | null = null;
      if (wasOpen) {
        scoring = await updateReliability(db, params.discrepancy_id);
      }

      // Audit trail (mirrors the dedup-merge admin_actions pattern).
      await db.insert(adminActions).values({
        action: "discrepancy.resolve",
        actorUserId: auth.userId ?? null,
        targetType: "event_discrepancy",
        targetId: params.discrepancy_id,
        payloadJson: JSON.stringify({
          newStatus: params.resolution_status,
          resolutionSource: params.resolution_source ?? null,
          previouslyOpen: wasOpen,
          scoringResult: scoring,
        }),
        createdAt: new Date(),
      });

      return {
        content: [
          jsonContent({
            ok: true,
            discrepancy_id: params.discrepancy_id,
            new_status: params.resolution_status,
            scoring_triggered: wasOpen,
            scoring,
          }),
        ],
      };
    }
  );

  // ── create_discrepancy ──────────────────────────────────────────
  server.tool(
    "create_discrepancy",
    "Manually capture a discrepancy. Used by agents that observed a cross-source conflict outside the automated capture paths (ingest_addverify, stale_page_radar, self_consistency). The created row carries detected_by='manual' and lands at outreach_priority_score=null until the next rerank pass. Admin only.",
    {
      event_id: z.string().describe("events.id this discrepancy is about"),
      field_class: z.enum(FIELD_CLASS_VALUES).describe("Which field of the event diverges"),
      authoritative_value: z
        .string()
        .max(1000)
        .transform(sanitizeProse)
        .optional()
        .describe("Currently-stored value MMATF treats as correct."),
      authoritative_source_url: z.string().url().optional(),
      divergent_value: z
        .string()
        .max(1000)
        .transform(sanitizeProse)
        .optional()
        .describe("The other source's claim."),
      divergent_source_url: z.string().url().optional(),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Detector confidence 0..1. Defaults to 0.9 for manual captures."),
      notes: z.string().max(1000).transform(sanitizeProse).optional(),
    },
    async (params) => {
      const id = crypto.randomUUID();
      const safeHost = (u?: string): string | null => {
        if (!u) return null;
        try {
          return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
        } catch {
          return null;
        }
      };

      // Compute the initial outreach_priority_score. Shared with the automated
      // capture path (OPE-245) via initialCaptureScore — neutral view-count /
      // reliability priors; the rerank pass upgrades with the real view count.
      const initialScore = initialCaptureScore({
        fieldClass: params.field_class,
        confidence: params.confidence ?? 0.9,
        detectedAt: new Date(),
      });

      await db.insert(eventDiscrepancies).values({
        id,
        eventId: params.event_id,
        fieldClass: params.field_class,
        detectedBy: "manual",
        detectedAt: new Date(),
        authoritativeValue: params.authoritative_value ?? null,
        authoritativeSourceKey: safeHost(params.authoritative_source_url),
        authoritativeSourceUrl: params.authoritative_source_url ?? null,
        divergentValue: params.divergent_value ?? null,
        divergentSourceKey: safeHost(params.divergent_source_url),
        divergentSourceUrl: params.divergent_source_url ?? null,
        confidence: params.confidence ?? 0.9,
        notes: params.notes ?? null,
        resolutionStatus: "open",
        outreachPriorityScore: initialScore,
        outreachCandidate: initialScore >= 0.6,
      });

      await db.insert(adminActions).values({
        action: "discrepancy.create",
        actorUserId: auth.userId ?? null,
        targetType: "event_discrepancy",
        targetId: id,
        payloadJson: JSON.stringify({
          eventId: params.event_id,
          fieldClass: params.field_class,
          via: "manual_mcp_create",
        }),
        createdAt: new Date(),
      });

      return {
        content: [
          jsonContent({
            ok: true,
            discrepancy_id: id,
            outreach_priority_score: initialScore,
          }),
        ],
      };
    }
  );

  // ── rerank_outreach_queue ───────────────────────────────────────
  // One-shot admin helper that runs the queue-rank batch immediately.
  // Used to backfill scores after the GW1d formula lands, and as a
  // manual refresh when view counts have moved materially.
  server.tool(
    "rerank_outreach_queue",
    "Run a batch of outreach-queue rank refreshes. Re-computes outreach_priority_score for open discrepancies that have no score yet OR were detected more than 24h ago. Caller chooses batch size up to 500. Admin only.",
    {
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(200)
        .describe("Rows per batch (default 200, max 500)."),
    },
    async (params) => {
      const result = await rerankOpenQueueBatch(db, { limit: params.batch_size ?? 200 });
      return {
        content: [
          jsonContent({
            ok: true,
            ...result,
          }),
        ],
      };
    }
  );
}

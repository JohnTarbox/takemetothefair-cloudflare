import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { claimAndFlush, type FlushOpts } from "../pending-pings.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

const ENTITY_TYPE_VALUES = ["vendor", "venue", "event", "promoter", "blog", "all"] as const;

export function registerFlushPendingSearchPingsTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "flush_pending_search_pings",
    "Drain queued IndexNow pings from pending_search_pings into one batched submission. Use after a bulk ingestion run that used defer_search_ping:true. Idempotent — empty queue returns flushed_count:0. Admin only.",
    {
      entity_type: z
        .enum(ENTITY_TYPE_VALUES)
        .optional()
        .default("all")
        .describe(
          "Restrict the flush to one entity type. Default 'all' drains everything pending."
        ),
      max_age_seconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Only flush rows whose queued_at is older than this many seconds. Null/omitted = flush regardless of age."
        ),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return counts only; no DB updates, no IndexNow call."),
    },
    async (params) => {
      const opts: FlushOpts = {
        entityType: params.entity_type ?? "all",
        maxAgeSeconds: params.max_age_seconds ?? null,
        dryRun: params.dry_run ?? false,
        source: "flush-pending",
      };

      const result = await claimAndFlush(db, env ?? {}, opts);

      if (!result.dryRun) {
        await db.insert(adminActions).values({
          action: "search_pings.flush",
          actorUserId: auth.userId,
          targetType: "system",
          targetId: result.batchId,
          payloadJson: JSON.stringify({
            entity_type: opts.entityType,
            max_age_seconds: opts.maxAgeSeconds,
            flushed_count: result.flushedCount,
            by_entity_type: result.byEntityType,
            indexnow_response: result.indexnowResponse,
          }),
          createdAt: new Date(),
        });
      }

      const ok = result.indexnowResponse === "ok" || result.dryRun;
      return {
        content: [
          jsonContent({
            batch_id: result.batchId,
            flushed_count: result.flushedCount,
            by_entity_type: result.byEntityType,
            indexnow_response: result.indexnowResponse,
            schema_org_regen_count: result.schemaOrgRegenCount,
            dry_run: result.dryRun,
          }),
        ],
        isError: !ok ? true : undefined,
      };
    }
  );
}

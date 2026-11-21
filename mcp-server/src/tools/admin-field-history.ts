/**
 * OPE-1651 — `get_entity_field_history`: read the per-field edit history for one
 * event, vendor, venue or promoter.
 *
 * Rows are written by `buildFieldHistoryRows` (packages/db-schema/src/field-history.ts)
 * from every wired write path, one row per field whose value actually changed.
 * History starts the day drizzle/0420 shipped; there is no backfill.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte } from "drizzle-orm";
import { entityFieldHistory } from "../schema.js";
import { jsonContent } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export const FIELD_HISTORY_DEFAULT_LIMIT = 100;
export const FIELD_HISTORY_MAX_LIMIT = 500;

export function registerFieldHistoryTools(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_entity_field_history",
    [
      "Read the field-level edit history for one event, vendor, venue or promoter, newest first.",
      "Each row is one field whose value changed: old_value, new_value (both in full, as text),",
      "actor (a user id, or system:<name> for a pipeline), source (the tool or route that wrote it,",
      "e.g. mcp:update_event, api:PATCH /api/vendor/profile) and request_id (rows sharing one",
      "request_id came from the same write call). `field` is the DB column name (snake_case).",
      "History starts 2026-11-16 (OPE-1651); a write path that does not log yet is listed in",
      "that ticket's PR. Not provenance: for WHY a value is believed, use get_event_field_provenance.",
      "Admin only.",
    ].join(" "),
    {
      entity_type: z.enum(["event", "vendor", "venue", "promoter"]),
      entity_id: z.string().min(1).describe("The entity's UUID."),
      field: z
        .string()
        .min(1)
        .optional()
        .describe("Only this column (snake_case, e.g. `description`, `image_url`)."),
      since: z.string().optional().describe("ISO-8601 date/time; only changes at or after it."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(FIELD_HISTORY_MAX_LIMIT)
        .optional()
        .describe(`Max rows (default ${FIELD_HISTORY_DEFAULT_LIMIT}).`),
    },
    async (params) => {
      let sinceDate: Date | null = null;
      if (params.since) {
        sinceDate = new Date(params.since);
        if (Number.isNaN(sinceDate.getTime())) {
          return {
            content: [jsonContent({ error: "invalid_since", since: params.since })],
            isError: true,
          };
        }
      }
      const limit = params.limit ?? FIELD_HISTORY_DEFAULT_LIMIT;
      const conds = [
        eq(entityFieldHistory.entityType, params.entity_type),
        eq(entityFieldHistory.entityId, params.entity_id),
      ];
      if (params.field) conds.push(eq(entityFieldHistory.field, params.field));
      if (sinceDate) conds.push(gte(entityFieldHistory.changedAt, sinceDate));

      // limit + 1 so `truncated` is a measurement, not a guess.
      const rows = await db
        .select()
        .from(entityFieldHistory)
        .where(and(...conds))
        .orderBy(desc(entityFieldHistory.changedAt), desc(entityFieldHistory.id))
        .limit(limit + 1);

      const truncated = rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      return {
        content: [
          jsonContent({
            entity_type: params.entity_type,
            entity_id: params.entity_id,
            count: page.length,
            truncated,
            history: page.map((r) => ({
              changed_at: r.changedAt instanceof Date ? r.changedAt.toISOString() : r.changedAt,
              field: r.field,
              old_value: r.oldValue,
              new_value: r.newValue,
              actor: r.actor,
              source: r.source,
              request_id: r.requestId,
            })),
          }),
        ],
      };
    }
  );
}

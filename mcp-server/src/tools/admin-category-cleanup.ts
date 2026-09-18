/**
 * OPE-1058 scope 2 — the operator's handle on the one-time category rewrite.
 *
 * The rewrite itself is a main-app route (it is a single writer over
 * `events.categories`, and the mapping lives in `src/`, which this Worker cannot
 * import). This tool is the way an operator or an agent runs it: the route needs
 * an admin session or the internal key, and the key only exists on the Workers.
 *
 * Dry-run by default, like the route: `apply` must be passed deliberately.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerCategoryCleanupTool(
  server: McpServer,
  auth: AuthContext,
  env?: MainAppEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "run_event_category_cleanup",
    "OPE-1058. Run the one-time event-category cleanup: map every off-list categories value onto the taxonomy John ratified 2026-09-17, rescue family-friendly/handmade into tags, and log every changed row to event_category_migration_log so the rewrite is reversible. " +
      "DRY RUN unless apply:true — the dry run reports the plan (per-value row counts, first 200 changed rows) and writes nothing. " +
      "Idempotent: re-running after a partial failure finishes the job rather than doubling it. The response's `still_off_list` is read back AFTER the writes, so it reports what actually remains. Admin only.",
    {
      apply: z
        .boolean()
        .optional()
        .default(false)
        .describe("Write the changes. Omit or false to plan only."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("Max rows to scan. Omit for all non-merged events."),
    },
    async (params) => {
      let res: Response;
      try {
        res = await mainAppFetch(env ?? {}, "/api/admin/events/category-cleanup", "fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        });
      } catch (e) {
        return {
          content: [
            jsonContent({
              error: "cleanup_unreachable",
              detail: e instanceof Error ? e.message : String(e),
            }),
          ],
          isError: true,
        };
      }
      const body = await res.text();
      if (!res.ok) {
        return {
          content: [jsonContent({ error: "cleanup_failed", status: res.status, body })],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: body }] };
    }
  );
}

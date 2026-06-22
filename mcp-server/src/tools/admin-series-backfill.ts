/**
 * EH3 P1 — `backfill_event_series` MCP tool (DRY-RUN ONLY in this build).
 *
 * Thin wrapper over the main app's POST /api/admin/series/backfill, which
 * computes how existing events would cluster into `event_series` and returns a
 * reviewable proposal. Mirrors the merge_events → /api/admin/duplicates/merge
 * pattern (X-Internal-Key over MAIN_APP_URL).
 *
 * The commit path is gated server-side (the route returns 423 for dry_run:false)
 * until the REL4-quiet + I1 gate opens — so this tool can only ever produce a
 * proposal today. See docs/eh3-p1-backfill-scoping.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

export function registerSeriesBackfillTools(server: McpServer, auth: AuthContext, env?: Env) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "backfill_event_series",
    [
      "EH3 P1 — preview the event-series backfill: how existing events would cluster",
      "into series (event_series) by (slug-stem, venue). Returns a summary plus the",
      "attention subsets: needs_manual_confirm (multi-occurrence + vendor roster — the",
      "only fuse risk), same_year_conflicts (likely true duplicates to merge_events,",
      "not co-link), and vendor slug-drift flags.",
      "",
      "DRY-RUN ONLY: the commit path (insert series + set events.series_id) is gated",
      "until the operator opens it; the underlying route returns 423 for a non-dry-run",
      "request in this build. Use this to review the proposal.",
    ].join(" "),
    {
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Defaults true (proposal only). dry_run:false attempts the COMMIT, which is additionally gated server-side by the EH3_P1_BACKFILL_ENABLED env flag — it returns 423 until an operator enables it."
        ),
      include_all_groups: z
        .boolean()
        .optional()
        .describe(
          "If true, also return the full lean group list (canonical_slug + member ids per group), not just the attention subsets. Defaults to false."
        ),
      confirm_series_slugs: z
        .array(z.string())
        .optional()
        .describe(
          "Canonical slugs of vendor-bearing multi-occurrence groups (needs_manual_confirm) to commit. Only consulted on a non-dry-run commit; without it those roster-fuse-risk groups are held back."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [{ type: "text", text: "MAIN_APP_URL or INTERNAL_API_KEY not configured." }],
          isError: true,
        };
      }

      const res = await fetch(`${env.MAIN_APP_URL}/api/admin/series/backfill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-key": env.INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          dry_run: params.dry_run ?? true,
          include_all_groups: params.include_all_groups ?? false,
          confirm_series_slugs: params.confirm_series_slugs ?? [],
        }),
      });

      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

      if (!res.ok || !data) {
        const err =
          (data?.error as string | undefined) ?? `backfill_event_series failed: HTTP ${res.status}`;
        return { content: [{ type: "text", text: err }], isError: true };
      }

      return { content: [jsonContent(data)] };
    }
  );
}

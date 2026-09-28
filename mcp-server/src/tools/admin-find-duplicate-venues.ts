/**
 * `find_duplicate_venues` admin MCP tool (OPE-1201 item 4).
 *
 * Thin read-only wrapper over `GET /api/admin/duplicates/sweep-entities`.
 * Before this, nothing an analyst could reach read that endpoint — only the
 * dedup canary polled it, for counts. So a duplicate venue row (Snowport: two
 * names, two venue rows, one place) was visible to no one, and every duplicate
 * EVENT that landed on the second row was invisible to event-level dedup too.
 *
 * Returns both lists the endpoint computes:
 *   - `near_pairs` — different names that look like one place (OPE-1201):
 *     ≥2 shared identifying tokens in one city, or ≤300 m apart with ≥1.
 *   - `exact_clusters` — spelling variants of one name in one city (DQ1).
 * Candidates only. The follow-up for a confirmed pair is `merge_venue`.
 *
 * Auth: ADMIN only at the MCP layer; forwards X-Internal-Key downstream.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import type { AuthContext } from "../auth.js";
import { mainAppFetch, type MainAppEnv } from "../main-app-fetch.js";

export function registerFindDuplicateVenuesTool(
  server: McpServer,
  auth: AuthContext,
  env?: MainAppEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "find_duplicate_venues",
    [
      "List likely-duplicate VENUE rows for merge_venue. Read-only.",
      "near_pairs: two different names that look like one place in the same city (e.g. 'Snowport at",
      "Boston Seaport' / 'Snowport at Seaport Common') — ≥2 shared identifying name tokens, or geocoded",
      "within 300 m with ≥1. exact_clusters: spelling variants of one name in one city.",
      "Candidates, not verdicts: check addresses before merging. Admin only.",
    ].join(" "),
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe("Max pairs / clusters to return (default 100)."),
    },
    async ({ limit }) => {
      let response: Response;
      try {
        response = await mainAppFetch(
          env ?? {},
          `/api/admin/duplicates/sweep-entities?limit=${limit}`,
          "fetch"
        );
      } catch (err) {
        return {
          content: [jsonContent({ ok: false, error: "transport", message: String(err) })],
          isError: true,
        };
      }
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 300);
        return {
          content: [jsonContent({ ok: false, status: response.status, body })],
          isError: true,
        };
      }
      const data = (await response.json()) as {
        venue_near_pairs?: unknown[];
        clusters?: Array<{ cluster_key?: string }>;
      };
      const nearPairs = data.venue_near_pairs ?? [];
      const exactClusters = (data.clusters ?? []).filter(
        (c) => c.cluster_key === "venue_name_city_state"
      );
      return {
        content: [
          jsonContent({
            ok: true,
            counts: { near_pairs: nearPairs.length, exact_clusters: exactClusters.length },
            near_pairs: nearPairs,
            exact_clusters: exactClusters,
            next_action_hint:
              "For a confirmed pair, compare addresses, then merge_venue(keeper, duplicate). After a venue merge, re-check the moved events for same-venue duplicates — the OPE-1201 daily sweep will also surface them.",
          }),
        ],
      };
    }
  );
}

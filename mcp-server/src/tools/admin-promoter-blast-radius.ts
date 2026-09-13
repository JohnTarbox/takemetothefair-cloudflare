/**
 * `get_promoter_blast_radius` (OPE-979) — "this promoter is gone; what does it
 * still own?"
 *
 * For Eagle Shows that question was assembled by hand, and the event that
 * mattered was reachable by one key only: its source_domain matched the dead
 * company's website host. A second Marlborough row sat under the community-
 * suggestions placeholder promoter and was reachable by nothing else at all.
 * Read-only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonContent } from "../helpers.js";
import { computePromoterBlastRadius } from "../promoters/succession.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerPromoterBlastRadiusTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_promoter_blast_radius",
    "OPE-979: everything a promoter still owns from today on — its event series, and every not-yet-finished event reached by promoter_id, by one of its series, OR by events.source_domain matching the promoter's website host. Each event lists which keys reached it (matched_by) and whether it is listed publicly; a row reached only by source_domain is one nothing else points at. Merge tombstones are excluded; REJECTED/CANCELLED rows are included and marked. Use before recording operating_status CEASED via update_promoter. Read-only, admin only.",
    {
      promoter_id: z.string().min(1).describe("Promoter ID (UUID)."),
      as_of: z
        .string()
        .datetime()
        .optional()
        .describe("ISO timestamp to treat as now (default: now). For reconstructing a past view."),
    },
    async (params) => {
      const now = params.as_of ? new Date(params.as_of) : new Date();
      const radius = await computePromoterBlastRadius(db, params.promoter_id, now);
      if (!radius) {
        return {
          content: [jsonContent({ error: "promoter_not_found", promoter_id: params.promoter_id })],
          isError: true,
        };
      }
      return {
        content: [
          jsonContent({
            as_of: now.toISOString(),
            promoter: radius.promoter,
            website_host: radius.websiteHost,
            summary: radius.summary,
            series: radius.series,
            future_events: radius.futureEvents.map((e) => ({
              id: e.id,
              name: e.name,
              slug: e.slug,
              start_date: e.startDate?.toISOString() ?? null,
              end_date: e.endDate?.toISOString() ?? null,
              status: e.status,
              lifecycle_status: e.lifecycleStatus,
              listed_publicly: e.listedPublicly,
              promoter_id: e.promoterId,
              series_id: e.seriesId,
              source_domain: e.sourceDomain,
              matched_by: e.matchedBy,
            })),
          }),
        ],
      };
    }
  );
}

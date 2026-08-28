/**
 * OPE-611 §1 — the reconciliation queue TENTATIVE never had.
 *
 * `update_event_lifecycle` already exists, validates transitions, writes an
 * `admin_actions` audit row and fires IndexNow on visibility boundaries. What
 * was missing is not a writer but a READER: nothing could tell an operator
 * WHICH of the 164 upcoming TENTATIVE events deserved a decision, so the answer
 * was "whichever one somebody happened to look at" — which is how the Concord
 * gem show reached one day before opening while invisible to the digest.
 *
 * This tool is deliberately read-only. Promotion is STOP-gated by the ticket.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import {
  readTentativePromotionQueue,
  selectImminentTentative,
  IMMINENT_DAYS,
} from "../events/tentative-queue.js";

export function registerTentativeQueueTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_tentative_promotion_queue",
    "OPE-611. Upcoming APPROVED events still sitting at lifecycle_status='TENTATIVE', ranked by promotion readiness. " +
      "Every downstream consumer that filters on lifecycle_status='SCHEDULED' — the weekend digest and any feed built on the same predicate — silently drops these, " +
      "so an event can be complete, sourced and publicly visible yet absent from the digest. " +
      "Tiers: 'ready' = dates_confirmed AND an active official_website citation AND no gate_flags; 'probable' = organizer-grade citation but one of the other two unmet; " +
      "'unverified' = no official_website citation, a human must source it. " +
      `Read-only: promoting a row is a separate, deliberate ${"`update_event_lifecycle`"} call. Admin only.`,
    {
      within_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          `Only events starting within this many days. Omit for the whole upcoming backlog. The operator alert uses ${IMMINENT_DAYS}.`
        ),
      tier: z
        .enum(["ready", "probable", "unverified"])
        .optional()
        .describe("Filter to one readiness tier."),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
    async (params) => {
      const rows = await readTentativePromotionQueue(db, new Date(), {
        withinSeconds: params.within_days == null ? undefined : params.within_days * 86400,
        limit: params.limit ?? 50,
      });
      const filtered = params.tier ? rows.filter((r) => r.tier === params.tier) : rows;

      const counts = {
        total: rows.length,
        ready: rows.filter((r) => r.tier === "ready").length,
        probable: rows.filter((r) => r.tier === "probable").length,
        unverified: rows.filter((r) => r.tier === "unverified").length,
        // What the operator notice would email about right now.
        imminent_actionable: selectImminentTentative(rows).length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                counts,
                imminent_days: IMMINENT_DAYS,
                events: filtered.map((r) => ({
                  slug: r.slug,
                  name: r.name,
                  tier: r.tier,
                  days_out: r.daysOut,
                  starts: r.startDate?.toISOString().slice(0, 10) ?? null,
                  dates_confirmed: r.datesConfirmed,
                  official_citations: r.officialCitations,
                  any_citations: r.anyCitations,
                  gate_flags: r.gateFlags,
                  view_count: r.viewCount,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

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
import { and, eq, gte, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { adminActions, events } from "../schema.js";
import { decodeHtmlEntities } from "../helpers.js";
import {
  readTentativePromotionQueue,
  selectImminentTentative,
  IMMINENT_DAYS,
  RECHECK_AFTER_DAYS,
} from "../events/tentative-queue.js";

/** How far back promotions-by-actor looks. */
const PROMOTION_LOOKBACK_DAYS = 30;

/**
 * OPE-611 rework — who has been promoting TENTATIVE rows, and how many.
 *
 * The OPE-612 drain's arithmetic stopped closing by exactly one when OPE-633
 * promoted a cohort row out of band. A count that does not say who moved the
 * rows cannot be reconciled against any one drain's receipts.
 */
async function promotionsByActor(db: Db, now: Date) {
  const since = new Date(now.getTime() - PROMOTION_LOOKBACK_DAYS * 86400_000);
  const rows = await db
    .select({
      actor: adminActions.actorUserId,
      n: sql<number>`COUNT(*)`,
    })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.action, "event.lifecycle_change"),
        gte(adminActions.createdAt, since),
        sql`json_extract(${adminActions.payloadJson}, '$.previous_lifecycle') = 'TENTATIVE'`,
        sql`json_extract(${adminActions.payloadJson}, '$.new_lifecycle') = 'SCHEDULED'`
      )
    )
    .groupBy(adminActions.actorUserId);
  return rows.map((r) => ({ actor_user_id: r.actor ?? null, promotions: Number(r.n) }));
}

export function registerTentativeQueueTool(server: McpServer, db: Db, auth: AuthContext) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "get_tentative_promotion_queue",
    "OPE-611. Upcoming APPROVED or TENTATIVE-status events (the two the public reader serves) still at lifecycle_status='TENTATIVE', ranked by promotion readiness. " +
      "Every downstream consumer that filters on lifecycle_status='SCHEDULED' — the weekend digest and any feed built on the same predicate — silently drops these, " +
      "so an event can be complete, sourced and publicly visible yet absent from the digest. " +
      "Tiers: 'ready' = dates_confirmed AND an active official_website citation on start_date (not on meetmeatthefair.com) AND no gate_flags; 'probable' = such a citation but one of the other two unmet; " +
      "'unverified' = no official_website citation on start_date, a human must source it. " +
      `Rows a human checked within ${RECHECK_AFTER_DAYS} days (record_tentative_check) sort last and carry their note. ` +
      "`as_of` is the instant the upcoming window was computed — diff two reads only when you account for events that started in between. " +
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
      const asOf = new Date();
      const rows = await readTentativePromotionQueue(db, asOf, {
        withinSeconds: params.within_days == null ? undefined : params.within_days * 86400,
        limit: params.limit ?? 50,
      });
      const filtered = params.tier ? rows.filter((r) => r.tier === params.tier) : rows;

      const counts = {
        total: rows.length,
        ready: rows.filter((r) => r.tier === "ready").length,
        probable: rows.filter((r) => r.tier === "probable").length,
        unverified: rows.filter((r) => r.tier === "unverified").length,
        recently_checked: rows.filter((r) => r.recentlyChecked).length,
        // What the operator notice would email about right now.
        imminent_actionable: selectImminentTentative(rows).length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                as_of: asOf.toISOString(),
                counts,
                imminent_days: IMMINENT_DAYS,
                recheck_after_days: RECHECK_AFTER_DAYS,
                promotions_by_actor_last_30d: await promotionsByActor(db, asOf),
                events: filtered.map((r) => ({
                  slug: r.slug,
                  name: r.name,
                  tier: r.tier,
                  days_out: r.daysOut,
                  starts: r.startDate?.toISOString().slice(0, 10) ?? null,
                  dates_confirmed: r.datesConfirmed,
                  status: r.status,
                  official_citations: r.officialCitations,
                  official_citations_other_fields: r.officialCitationsOtherFields,
                  last_checked_at: r.lastCheckedAt?.toISOString() ?? null,
                  check_note: r.checkNote,
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

  server.tool(
    "record_tentative_check",
    "OPE-611. Record that you CHECKED a TENTATIVE event's lifecycle and deliberately left it TENTATIVE, with what you found. " +
      "update_event_lifecycle writes lifecycle_reason only on a transition, so without this a verified-and-held row is indistinguishable from one nobody opened, " +
      `and every drain re-works it. The row sorts last in get_tentative_promotion_queue and stays out of the operator notice for ${RECHECK_AFTER_DAYS} days. ` +
      "Does NOT change lifecycle_status. To promote, call update_event_lifecycle (which also stamps the check). Admin only.",
    {
      event_id: z.string().min(1).describe("Event id."),
      note: z
        .string()
        .min(1)
        .max(500)
        .transform(decodeHtmlEntities)
        .describe(
          "What you found and why it stays TENTATIVE, e.g. 'organizer page still shows 2025 edition' or 'organizer publishes May 15-16 2027 (Tentative)'."
        ),
    },
    async (params) => {
      const [row] = await db
        .select({ id: events.id, slug: events.slug, lifecycleStatus: events.lifecycleStatus })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (!row) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "event_not_found" }) }],
          isError: true,
        };
      }
      if (row.lifecycleStatus !== "TENTATIVE") {
        // A check note on a SCHEDULED row would read as a held verdict on a row
        // that is not held. Refuse rather than record something misleading.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "not_tentative",
                lifecycle_status: row.lifecycleStatus,
                hint: "Only a TENTATIVE row can be checked-and-held; use update_event_lifecycle to change state.",
              }),
            },
          ],
          isError: true,
        };
      }
      const now = new Date();
      await db
        .update(events)
        .set({ lifecycleLastCheckedAt: now, lifecycleCheckNote: params.note })
        .where(eq(events.id, row.id));
      await db.insert(adminActions).values({
        action: "event.lifecycle_check",
        actorUserId: auth.userId,
        targetType: "event",
        targetId: row.id,
        payloadJson: JSON.stringify({ lifecycle: "TENTATIVE", note: params.note, slug: row.slug }),
        createdAt: now,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              event_id: row.id,
              slug: row.slug,
              checked_at: now.toISOString(),
              recheck_after: new Date(now.getTime() + RECHECK_AFTER_DAYS * 86400_000).toISOString(),
            }),
          },
        ],
      };
    }
  );
}

/**
 * OPE-240 — read the staged booth-photo proposals.
 *
 * ## Why this exists
 *
 * `autoWriteBooths` is STOP-gated behind `PHOTO_AUTOWRITE_ENABLED` and has
 * never executed in production. The decision to enable it is meant to be judged
 * on the proposals the pipeline has staged — and on 2026-08-20 the review lane
 * could not read them:
 *
 *   > "the staging rows live in `admin_actions`, which no read-only MMATF tool
 *      exposes; `get_admin_action_log` is first-party analytics only."
 *
 * So a gate that exists to be judged on evidence had no way to show the
 * evidence. That review also reported "exactly one real staged proposal"; there
 * are **four**, and the other three are the informative ones — two genuine
 * non-identifications and one intermittent parse failure. A sample of one looks
 * like a flawless classifier; a sample of four shows its failure modes.
 *
 * Read-only. It cannot enable anything, write anything, or approve a proposal —
 * the point is to make the gate decidable, not to pre-empt it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { adminActions, events } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { BOOTH_PROPOSED_ACTION } from "../photo/booth-pipeline.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

/** Shape written by the booth pipeline's staging step. */
interface ProposalPayload {
  event_id?: string;
  photo_key?: string;
  photo_name?: string;
  business_name?: string | null;
  website?: string | null;
  products?: string[];
  confidence?: number;
  rationale?: string;
  failure_reason?: string | null;
  would_auto_write?: boolean;
  stage_reason?: string | null;
}

export function registerPhotoProposalTools(server: McpServer, db: Db, auth: AuthContext): void {
  server.tool(
    "list_photo_proposals",
    "OPE-240 — the booth-photo proposals the vision pipeline has STAGED, with what it identified, its confidence, whether it would have auto-written, and why it staged instead. This is the evidence the PHOTO_AUTOWRITE_ENABLED gate is meant to be judged on; it was previously unreadable outside /admin. Read-only: it cannot enable, write or approve anything.",
    {
      would_auto_write: z
        .boolean()
        .optional()
        .describe(
          "Filter to proposals that WOULD have been written had the gate been open (true), or that would have staged regardless (false). Omit for all."
        ),
      failed_only: z
        .boolean()
        .optional()
        .describe(
          "Only proposals carrying a failure_reason — the vision call did not yield a usable verdict. These are pipeline faults, distinct from a confident 'I cannot tell what this shows'."
        ),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("Only proposals from the last N days. Omit for all time."),
      limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Admin role required." }],
          isError: true,
        };
      }

      const limit = params.limit ?? 50;
      const filters = [eq(adminActions.action, BOOTH_PROPOSED_ACTION)];
      if (params.days !== undefined) {
        filters.push(
          gte(adminActions.createdAt, new Date(Date.now() - params.days * 24 * 60 * 60 * 1000))
        );
      }

      const rows = await db
        .select({
          id: adminActions.id,
          inboundEmailId: adminActions.targetId,
          payload: adminActions.payloadJson,
          createdAt: adminActions.createdAt,
        })
        .from(adminActions)
        .where(and(...filters))
        .orderBy(desc(adminActions.createdAt))
        .limit(limit);

      // Event names resolved in one pass, not per row — this list is read while
      // judging a gate, and N+1 on an admin read is how a diagnostic becomes
      // too slow to use.
      const eventIds = new Set<string>();
      const parsed = rows.map((r) => {
        let p: ProposalPayload = {};
        try {
          p = JSON.parse(r.payload ?? "{}") as ProposalPayload;
        } catch {
          // A row whose payload will not parse is itself worth seeing rather
          // than silently dropping — that is the shape of a writer change that
          // broke the record format.
          p = { rationale: "payload_json did not parse" };
        }
        if (p.event_id) eventIds.add(p.event_id);
        return { row: r, p };
      });

      const eventNames = new Map<string, string>();
      if (eventIds.size > 0) {
        const evs = await db
          .select({ id: events.id, name: events.name, slug: events.slug })
          .from(events)
          .where(sql`${events.id} IN ${[...eventIds]}`);
        for (const e of evs) eventNames.set(e.id, e.name);
      }

      const proposals = parsed.map(({ row, p }) => ({
        id: row.id,
        created_at: row.createdAt,
        inbound_email_id: row.inboundEmailId,
        event_id: p.event_id ?? null,
        event_name: p.event_id ? (eventNames.get(p.event_id) ?? null) : null,
        photo_name: p.photo_name ?? null,
        photo_key: p.photo_key ?? null,
        business_name: p.business_name ?? null,
        website: p.website ?? null,
        products: p.products ?? [],
        confidence: p.confidence ?? null,
        would_auto_write: p.would_auto_write ?? false,
        // Why it staged, and — separately — whether the vision call itself
        // failed. A confident "I cannot tell what this shows" and a parse
        // failure both end in a staged row, and they need different fixes.
        stage_reason: p.stage_reason ?? null,
        failure_reason: p.failure_reason ?? null,
        rationale: p.rationale ?? null,
      }));

      const filtered = proposals.filter((x) => {
        if (params.would_auto_write !== undefined && x.would_auto_write !== params.would_auto_write)
          return false;
        if (params.failed_only === true && !x.failure_reason) return false;
        return true;
      });

      return {
        content: [
          jsonContent({
            proposals: filtered,
            count: filtered.length,
            // A gate judged on "how many would have been written" needs the
            // denominator too, or one confident hit reads as a flawless
            // classifier.
            summary: {
              total_staged: proposals.length,
              would_have_written: proposals.filter((x) => x.would_auto_write).length,
              vision_failures: proposals.filter((x) => x.failure_reason).length,
              identified_but_below_threshold: proposals.filter(
                (x) => x.business_name && !x.would_auto_write
              ).length,
            },
            note:
              proposals.length === 0
                ? "No staged proposals. PHOTO_VISION_ENABLED must be on for the pipeline to produce any."
                : undefined,
          }),
        ],
      };
    }
  );
}

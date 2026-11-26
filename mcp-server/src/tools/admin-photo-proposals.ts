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
 * `list_photo_proposals` is read-only. It cannot enable anything, write
 * anything, or approve a proposal — the point is to make the gate decidable,
 * not to pre-empt it. `repoint_photo_intake` (OPE-1697) moves an upload to the
 * fair it was really taken at, and `review_photo_proposal` (OPE-1704) resolves
 * one proposal — approve, reject, or close it as already handled by hand.
 *
 * OPE-1704 — `list_photo_proposals` defaults to OPEN proposals. Until then it
 * returned every staged row forever, so a booth approved in the admin UI, or
 * cleared by hand, still read as waiting and "what's left?" had no answer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { chunkIds } from "@takemetothefair/utils";
import { adminActions, events } from "../schema.js";
import { decodeHtmlEntities, jsonContent } from "../helpers.js";
import {
  BOOTH_PROPOSED_ACTION,
  CARD_PROPOSED_ACTION,
  PERFORMER_PROPOSED_ACTION,
} from "../photo/booth-pipeline.js";
import type { Db } from "../db.js";
import { computeIntakeAccounting } from "../photo/intake-accounting.js";
import { pairingsForProposals } from "../photo/card-pairing.js";
import { PHOTO_RESOLVED_ACTION, repointPhotoIntake } from "../photo/repoint.js";
import { PROPOSAL_DECISIONS, reviewPhotoProposal } from "../photo/review-proposal.js";
import type { AutoWriteEnv } from "../photo/auto-write.js";
import type { AuthContext } from "../auth.js";

/** Shape written by the booth pipeline's staging step. */
interface ProposalPayload {
  sign_mounted_on?: string | null;
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
  /** OPE-969 — absent on rows staged before the class split. */
  photo_class?: string;
  stage_kind?: string | null;
  performer_name?: string | null;
  performer_id?: string | null;
  matched_performer_name?: string | null;
  appearances_on_event?: number;
  /** OPE-1694 — the sign's domain and what it matched. */
  matched_domain?: string | null;
  match_basis?: "domain" | null;
  matched_vendor_id?: string | null;
  matched_vendor_name?: string | null;
  domain_candidates?: Array<{ id: string; businessName: string }>;
}

export const PROPOSAL_STATUS_VALUES = [
  "open",
  "approved",
  "rejected",
  "already_handled",
  "all",
] as const;
export type ProposalStatusFilter = (typeof PROPOSAL_STATUS_VALUES)[number];

/**
 * OPE-1704 — the SQL predicate for a status filter, as a correlated subquery on
 * the resolution row (`vendor.photo_resolved`, target_type 'admin_action',
 * target_id = the proposal). Keyed on (target_type, target_id) so it uses
 * `idx_admin_actions_target`. In SQL, not in memory, so `limit` counts the
 * rows the caller asked for rather than truncating before the filter.
 */
function statusPredicate(status: ProposalStatusFilter): SQL | null {
  if (status === "all") return null;
  const resolved = sql`SELECT 1 FROM admin_actions r WHERE r.action = ${PHOTO_RESOLVED_ACTION} AND r.target_type = 'admin_action' AND r.target_id = ${adminActions.id}`;
  if (status === "open") return sql`NOT EXISTS (${resolved})`;
  return sql`EXISTS (${resolved} AND json_extract(r.payload_json, '$.resolution') = ${status})`;
}

export function registerPhotoProposalTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: AutoWriteEnv
): void {
  server.tool(
    "list_photo_proposals",
    "OPE-240 — the photo proposals the vision pipeline has STAGED (booths, and since OPE-969 performers), with what it identified, its confidence, whether it would have auto-written, and why it staged instead. `photo_class` says what the photo is and `stage_kind` why it staged, so 'a booth whose name is unreadable' and 'not a booth' are distinguishable. This is the evidence the PHOTO_AUTOWRITE_ENABLED gate is meant to be judged on. Read-only: it cannot enable, write or approve anything.",
    {
      photo_class: z
        .enum(["booth", "performer", "business_card"])
        .optional()
        .describe(
          "OPE-969: only booth, performer, or (OPE-1705) business-card proposals. Omit for all. Rows staged before 2026-09-13 have no class and are booth proposals. A business-card proposal is approved with review_photo_proposal(vendor_id) and never publishes its image."
        ),
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
        .describe(
          "Only proposals from the last N days. Omit for all time. With a window, the response also carries `intake_accounting` (OPE-978): photo-intake emails and photos in, the outcome each photo got (proposed, auto-written, performer, signage, gallery), and any photo with no recorded outcome, by name."
        ),
      status: z
        .enum(PROPOSAL_STATUS_VALUES)
        .optional()
        .describe(
          "OPE-1704: 'open' (default) = not yet resolved; 'approved' / 'rejected' / 'already_handled' = resolved that way (in review_photo_proposal or the admin UI); 'all' = every staged row."
        ),
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
      const status: ProposalStatusFilter = params.status ?? "open";
      const wanted =
        params.photo_class === "booth"
          ? [BOOTH_PROPOSED_ACTION]
          : params.photo_class === "performer"
            ? [PERFORMER_PROPOSED_ACTION]
            : params.photo_class === "business_card"
              ? [CARD_PROPOSED_ACTION]
              : [BOOTH_PROPOSED_ACTION, PERFORMER_PROPOSED_ACTION, CARD_PROPOSED_ACTION];
      const filters: SQL[] = [inArray(adminActions.action, wanted)];
      const statusSql = statusPredicate(status);
      if (statusSql) filters.push(statusSql);
      if (params.days !== undefined) {
        filters.push(
          gte(adminActions.createdAt, new Date(Date.now() - params.days * 24 * 60 * 60 * 1000))
        );
      }

      const rows = await db
        .select({
          id: adminActions.id,
          action: adminActions.action,
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

      // OPE-1053 — in chunks. `limit` allows 200 rows, so this set can hold up
      // to 200 distinct ids, and one `IN (…)` binds one parameter per id against
      // D1's 100-parameter cap. Local better-sqlite3 allows 32,766, which is why
      // the single-statement form passed every test.
      const eventNames = new Map<string, string>();
      for (const batch of chunkIds([...eventIds])) {
        const evs = await db
          .select({ id: events.id, name: events.name })
          .from(events)
          .where(inArray(events.id, batch));
        for (const e of evs) eventNames.set(e.id, e.name);
      }

      // OPE-1704 — each row's resolution, in chunks (same 100-param cap). The
      // FIRST resolution row wins, matching review_photo_proposal's read.
      const resolutions = new Map<
        string,
        {
          resolution: string | null;
          at: Date | null;
          by: string | null;
          payload: Record<string, unknown>;
        }
      >();
      for (const batch of chunkIds(rows.map((r) => r.id))) {
        const res = await db
          .select({
            targetId: adminActions.targetId,
            payload: adminActions.payloadJson,
            createdAt: adminActions.createdAt,
            actorUserId: adminActions.actorUserId,
          })
          .from(adminActions)
          .where(
            and(
              eq(adminActions.action, PHOTO_RESOLVED_ACTION),
              eq(adminActions.targetType, "admin_action"),
              inArray(adminActions.targetId, batch)
            )
          )
          .orderBy(asc(adminActions.createdAt), asc(adminActions.id));
        for (const r of res) {
          if (!r.targetId || resolutions.has(r.targetId)) continue;
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
          } catch {
            payload = {};
          }
          resolutions.set(r.targetId, {
            resolution: typeof payload.resolution === "string" ? payload.resolution : null,
            at: r.createdAt ?? null,
            by: r.actorUserId ?? null,
            payload,
          });
        }
      }

      // OPE-1705 slice 2 — a card paired with a booth, shown on both rows.
      const pairings = await pairingsForProposals(
        db,
        rows.map((r) => r.id)
      );
      const pairedWith = (id: string, action: string) => {
        const pr = pairings.get(id);
        if (!pr) return null;
        const isCard = action === CARD_PROPOSED_ACTION;
        return {
          pairing: pr.pairing ?? null,
          basis: pr.basis ?? null,
          effect: pr.effect ?? null,
          vendor_id: pr.vendor_id ?? null,
          ...(isCard
            ? {
                booth_email_id: pr.booth_email_id ?? null,
                booth_photo_key: pr.booth_photo_key ?? null,
                booth_business_name: pr.booth_business_name ?? null,
              }
            : {
                card_email_id: pr.card_email_id ?? null,
                card_photo_key: pr.card_photo_key ?? null,
                // An unreadable booth's name, read off the card shot after it.
                resolved_business_name: pr.resolved_business_name ?? null,
              }),
        };
      };
      const proposals = parsed.map(({ row, p }) => ({
        id: row.id,
        created_at: row.createdAt,
        // OPE-1704 — open until a resolution row exists; then how it closed.
        status: resolutions.get(row.id)?.resolution ?? "open",
        resolved_at: resolutions.get(row.id)?.at ?? null,
        resolved_by: resolutions.get(row.id)?.by ?? null,
        resolution_note: (resolutions.get(row.id)?.payload.note as string | undefined) ?? null,
        resolved_vendor_id:
          (resolutions.get(row.id)?.payload.vendor_id as string | undefined) ?? null,
        inbound_email_id: row.inboundEmailId,
        event_id: p.event_id ?? null,
        event_name: p.event_id ? (eventNames.get(p.event_id) ?? null) : null,
        photo_name: p.photo_name ?? null,
        photo_key: p.photo_key ?? null,
        // OPE-969 — a pre-split row carries no class; every such row was
        // written by the booth path, so that is what it is.
        photo_class:
          p.photo_class ??
          (row.action === PERFORMER_PROPOSED_ACTION
            ? "performer"
            : row.action === CARD_PROPOSED_ACTION
              ? "business_card"
              : "booth"),
        stage_kind: p.stage_kind ?? null,
        paired: pairedWith(row.id, row.action),
        // OPE-240 — the booth/not-booth answer, on rows that reached the gate.
        sign_mounted_on: p.sign_mounted_on ?? null,
        business_name: p.business_name ?? null,
        performer_name: p.performer_name ?? null,
        performer_id: p.performer_id ?? null,
        matched_performer_name: p.matched_performer_name ?? null,
        appearances_on_event: p.appearances_on_event ?? null,
        website: p.website ?? null,
        // OPE-1694 — "domain" when the sign's web address names an existing vendor.
        match_basis: p.match_basis ?? null,
        matched_domain: p.matched_domain ?? null,
        matched_vendor_id: p.matched_vendor_id ?? null,
        matched_vendor_name: p.matched_vendor_name ?? null,
        domain_candidates: p.domain_candidates ?? null,
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

      // OPE-978 — with a window, also account for every photo that came IN:
      // proposals are one outcome among six, and a photo in none of them is
      // named rather than silently missing from the count.
      const intakeAccounting =
        params.days !== undefined
          ? await computeIntakeAccounting(db, new Date(Date.now() - params.days * 86_400_000))
          : undefined;

      return {
        content: [
          jsonContent({
            status_filter: status,
            proposals: filtered,
            count: filtered.length,
            // A gate judged on "how many would have been written" needs the
            // denominator too, or one confident hit reads as a flawless
            // classifier.
            summary: {
              total_staged: proposals.length,
              performer_proposals: proposals.filter((x) => x.photo_class === "performer").length,
              would_have_written: proposals.filter((x) => x.would_auto_write).length,
              vision_failures: proposals.filter((x) => x.failure_reason).length,
              identified_but_below_threshold: proposals.filter(
                (x) => x.business_name && !x.would_auto_write
              ).length,
            },
            ...(intakeAccounting ? { intake_accounting: intakeAccounting } : {}),
            note:
              proposals.length === 0
                ? `No ${status === "all" ? "" : `${status} `}staged proposals.${status === "all" ? "" : " Pass status:'all' to include every staged row."} PHOTO_VISION_ENABLED must be on for the pipeline to produce any.`
                : undefined,
          }),
        ],
      };
    }
  );

  server.tool(
    "repoint_photo_intake",
    "OPE-1697 — move a photo-intake upload (a Snap or an emailed photo) from the fair it was attributed to, to the fair it was actually taken at. Moves its UNRESOLVED proposals (their event_id is what approval writes to), the event_vendors links it auto-wrote (a link that existed before the upload stays and the vendor is also linked on the new fair), and the row's resulting_event_id. Already-approved/rejected proposals and gallery photos already in event_photos are reported, not moved. Defaults to dry_run=true: run once to see the plan, then again with dry_run=false. Idempotent.",
    {
      inbound_email_id: z
        .string()
        .max(80)
        .optional()
        .describe("The upload's inbound_emails id (a Snap row is `snap-<uuid>`)."),
      proposal_id: z
        .string()
        .max(80)
        .optional()
        .describe(
          "Instead of inbound_email_id: the admin_actions id of any proposal from the upload (as list_photo_proposals returns it)."
        ),
      to_event_id: z.string().min(1).max(80).describe("The fair the photos were really taken at."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Default true — report what would move, write nothing."),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Admin role required." }],
          isError: true,
        };
      }
      if (!params.inbound_email_id && !params.proposal_id) {
        return {
          content: [{ type: "text" as const, text: "Pass inbound_email_id or proposal_id." }],
          isError: true,
        };
      }
      const out = await repointPhotoIntake(db, {
        inboundEmailId: params.inbound_email_id ?? null,
        proposalId: params.proposal_id ?? null,
        toEventId: params.to_event_id,
        dryRun: params.dry_run !== false,
        actorUserId: auth.userId ?? null,
      });
      if (!out.ok) {
        return { content: [{ type: "text" as const, text: out.error }], isError: true };
      }
      return { content: [jsonContent(out)] };
    }
  );

  server.tool(
    "review_photo_proposal",
    "OPE-1704 — resolve ONE staged photo proposal (the id list_photo_proposals returns). decision='approve' (booth proposals only): create or link the vendor with STRICT dedup and the sign-domain match — or link vendor_id directly — as a CONFIRMED exhibitor on the proposal's fair, then write the photo as the vendor's logo if it has none, otherwise append it to their gallery (a logo is never overwritten). A new vendor gets a public page, as with review_exhibitor_proposal. decision='reject': close it, write nothing. decision='already_handled': close it without writing, for a booth cleared by hand. A proposal resolves once: a second call writes nothing and returns the first decision (already_resolved:true). Same record as the admin UI's approve/reject, so either surface sees the other's decisions. Admin only.",
    {
      proposal_id: z
        .string()
        .min(1)
        .max(80)
        .describe("The proposal's id from list_photo_proposals."),
      decision: z.enum(PROPOSAL_DECISIONS),
      business_name: z
        .string()
        .max(200)
        .transform(decodeHtmlEntities)
        .optional()
        .describe(
          "approve: the business name, overriding what the model read. Required when the proposal has no name (an unreadable sign) and no vendor_id is given."
        ),
      vendor_id: z
        .string()
        .max(80)
        .optional()
        .describe(
          "approve: link this existing vendor instead of matching by name/domain. Followed through merges to the live record; a deleted vendor is refused."
        ),
      note: z
        .string()
        .max(1000)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Why — kept on the decision. Recommended for reject and already_handled."),
    },
    async (params) => {
      if (auth.role !== "ADMIN") {
        return {
          content: [{ type: "text" as const, text: "Admin role required." }],
          isError: true,
        };
      }
      if (params.decision !== "approve" && (params.business_name || params.vendor_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "business_name and vendor_id apply only to decision='approve'; nothing was written.",
            },
          ],
          isError: true,
        };
      }
      const out = await reviewPhotoProposal(env ?? {}, db, {
        proposalId: params.proposal_id,
        decision: params.decision,
        businessName: params.business_name ?? null,
        vendorId: params.vendor_id ?? null,
        note: params.note ?? null,
        actorUserId: auth.userId ?? null,
      });
      if (!out.ok) {
        return { content: [jsonContent(out)], isError: true };
      }
      return { content: [jsonContent(out)] };
    }
  );
}

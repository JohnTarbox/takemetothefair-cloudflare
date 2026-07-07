/**
 * Performer pre-extraction review surface (OPE-116) — the performer analog of
 * admin-promoter-enrichment-review.ts.
 *
 * enrich_performer STAGES fill-empty proposals in
 * `performer_enrichment_candidates` (dry-run by default). These two admin tools
 * let an operator drain that queue without raw SQL:
 *
 *   - `list_performer_enrichment_candidates`  — filter/inspect staged proposals.
 *   - `review_performer_enrichment_candidate` — approve one proposal (apply the
 *     value to the live performer, fill-empty-only, then recompute
 *     enrichment_status/coverage + ping IndexNow) or reject it.
 *
 * Approve works regardless of the global ENRICHMENT_DRY_RUN switch — it's an
 * explicit human decision. The fill-empty-only contract still holds: if the
 * live field was populated since staging, approve records the decision without
 * clobbering it. All five performer fields (image, description, social_links,
 * contact_email, contact_phone) are applicable here.
 *
 * IndexNow is pinged INLINE (not via the deferred outbox the promoter surface
 * uses) — performer review volume is low enough that batching isn't warranted.
 *
 * Admin only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { computePerformerEnrichment } from "@takemetothefair/constants";
import { adminActions, performerEnrichmentCandidates, performers } from "../schema.js";
import { jsonContent, logEnrichment, publicUrlFor, triggerIndexNow } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  DB?: D1Database;
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/** Staged-field → live performer column. All five are applicable. */
const FIELD_TO_COLUMN: Record<string, keyof typeof performers.$inferInsert> = {
  image: "imageUrl",
  description: "description",
  social_links: "socialLinks",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
};

const PROPOSED_FIELDS = [
  "image",
  "description",
  "social_links",
  "contact_email",
  "contact_phone",
] as const;

/** A performer field is "empty" (fill-eligible) when blank; social_links also
 *  when an empty object/array literal. (No description placeholder for acts.) */
function isEmptyFieldValue(field: string, value: string | null): boolean {
  const v = (value ?? "").trim();
  if (v === "") return true;
  if (field === "social_links") return v === "{}" || v === "[]";
  return false;
}

export function registerPerformerEnrichmentReviewTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  // --- list_performer_enrichment_candidates -------------------------------
  server.tool(
    "list_performer_enrichment_candidates",
    "List staged performer pre-extraction proposals from performer_enrichment_candidates for review. Filter by decision (default 'pending'), flag status, performer, field, or minimum confidence. Each row carries the proposed field/value, the performer's value at proposal time, source URL, extraction method, confidence, and any safety flags. Also returns a summary of totals by decision and a clean-vs-flagged breakdown of the pending queue. Read-only. Admin only.",
    {
      decision: z
        .enum(["pending", "approved", "rejected", "auto_merged", "all"])
        .optional()
        .default("pending")
        .describe("Filter by review decision. 'all' returns every decision. Default 'pending'."),
      flagged: z
        .enum(["all", "only", "clean"])
        .optional()
        .default("all")
        .describe(
          "Filter by safety-flag status: 'only' = has ≥1 flag, 'clean' = no flags, 'all' = both. Default 'all'."
        ),
      performer_id: z.string().optional().describe("Restrict to a single performer."),
      field: z.enum(PROPOSED_FIELDS).optional().describe("Restrict to one proposed field."),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Only proposals at or above this confidence (0–1)."),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async (params) => {
      const decision = params.decision ?? "pending";
      const flagged = params.flagged ?? "all";
      const limit = params.limit ?? 50;

      const conds = [];
      if (decision !== "all") conds.push(eq(performerEnrichmentCandidates.decision, decision));
      if (params.performer_id)
        conds.push(eq(performerEnrichmentCandidates.performerId, params.performer_id));
      if (params.field) conds.push(eq(performerEnrichmentCandidates.proposedField, params.field));
      if (typeof params.min_confidence === "number")
        conds.push(gte(performerEnrichmentCandidates.confidence, params.min_confidence));
      if (flagged === "only") conds.push(sql`${performerEnrichmentCandidates.flags} <> '[]'`);
      if (flagged === "clean") conds.push(eq(performerEnrichmentCandidates.flags, "[]"));

      const rows = await db
        .select({
          id: performerEnrichmentCandidates.id,
          performerId: performerEnrichmentCandidates.performerId,
          name: performers.name,
          field: performerEnrichmentCandidates.proposedField,
          currentValue: performerEnrichmentCandidates.currentValue,
          proposedValue: performerEnrichmentCandidates.proposedValue,
          extractionMethod: performerEnrichmentCandidates.extractionMethod,
          fetchMethod: performerEnrichmentCandidates.fetchMethod,
          confidence: performerEnrichmentCandidates.confidence,
          flags: performerEnrichmentCandidates.flags,
          sourceUrl: performerEnrichmentCandidates.sourceUrl,
          decision: performerEnrichmentCandidates.decision,
          createdAt: performerEnrichmentCandidates.createdAt,
          jobRunId: performerEnrichmentCandidates.jobRunId,
        })
        .from(performerEnrichmentCandidates)
        .leftJoin(performers, eq(performers.id, performerEnrichmentCandidates.performerId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(performerEnrichmentCandidates.createdAt))
        .limit(limit);

      const totalsByDecision = await db
        .select({
          decision: performerEnrichmentCandidates.decision,
          n: sql<number>`count(*)`,
        })
        .from(performerEnrichmentCandidates)
        .groupBy(performerEnrichmentCandidates.decision);

      const pendingSplit = await db
        .select({
          flagged: sql<number>`CASE WHEN ${performerEnrichmentCandidates.flags} = '[]' THEN 0 ELSE 1 END`,
          n: sql<number>`count(*)`,
        })
        .from(performerEnrichmentCandidates)
        .where(eq(performerEnrichmentCandidates.decision, "pending"))
        .groupBy(sql`CASE WHEN ${performerEnrichmentCandidates.flags} = '[]' THEN 0 ELSE 1 END`);

      const pendingClean = pendingSplit.find((r) => Number(r.flagged) === 0)?.n ?? 0;
      const pendingFlagged = pendingSplit.find((r) => Number(r.flagged) === 1)?.n ?? 0;

      return {
        content: [
          jsonContent({
            count: rows.length,
            limit,
            filters: {
              decision,
              flagged,
              performer_id: params.performer_id,
              field: params.field,
            },
            summary: {
              by_decision: Object.fromEntries(
                totalsByDecision.map((r) => [r.decision, Number(r.n)])
              ),
              pending_clean: Number(pendingClean),
              pending_flagged: Number(pendingFlagged),
            },
            candidates: rows.map((r) => ({
              id: r.id,
              performer_id: r.performerId,
              name: r.name,
              field: r.field,
              current_value: r.currentValue,
              proposed_value: r.proposedValue,
              extraction_method: r.extractionMethod,
              fetch_method: r.fetchMethod,
              confidence: r.confidence,
              flags: JSON.parse(r.flags) as string[],
              source_url: r.sourceUrl,
              decision: r.decision,
              job_run_id: r.jobRunId,
              created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
            })),
          }),
        ],
      };
    }
  );

  // --- review_performer_enrichment_candidate ------------------------------
  server.tool(
    "review_performer_enrichment_candidate",
    "Approve or reject one staged performer pre-extraction proposal (by candidate id from list_performer_enrichment_candidates). approve = apply the proposed value to the live performer, fill-empty-only (won't clobber a field populated since the proposal was staged), then recompute enrichment_status/coverage + ping IndexNow; the candidate is marked 'approved'. reject = mark 'rejected', no performer change. All five fields (image, description, social_links, contact_email, contact_phone) are applicable. Works regardless of the global ENRICHMENT_DRY_RUN switch. Admin only.",
    {
      candidate_id: z.number().int().positive().describe("Candidate row id (from list)."),
      action: z.enum(["approve", "reject"]).describe("approve = apply fill; reject = discard."),
      note: z
        .string()
        .max(500)
        .optional()
        .describe("Optional reviewer note (stored in audit log)."),
    },
    async (params) => {
      const [cand] = await db
        .select()
        .from(performerEnrichmentCandidates)
        .where(eq(performerEnrichmentCandidates.id, params.candidate_id))
        .limit(1);
      if (!cand) {
        return {
          content: [
            jsonContent({ error: "candidate_not_found", candidate_id: params.candidate_id }),
          ],
          isError: true,
        };
      }
      if (cand.decision !== "pending") {
        return {
          content: [
            jsonContent({
              error: "already_reviewed",
              candidate_id: params.candidate_id,
              decision: cand.decision,
            }),
          ],
          isError: true,
        };
      }

      const [performer] = await db
        .select()
        .from(performers)
        .where(eq(performers.id, cand.performerId))
        .limit(1);
      if (!performer) {
        return {
          content: [jsonContent({ error: "performer_not_found", performer_id: cand.performerId })],
          isError: true,
        };
      }

      const now = new Date();

      // --- reject ---
      if (params.action === "reject") {
        await db
          .update(performerEnrichmentCandidates)
          .set({ decision: "rejected", reviewedAt: now, reviewedBy: auth.userId })
          .where(eq(performerEnrichmentCandidates.id, cand.id));
        await writeAudit(db, auth, cand, {
          action: "reject",
          applied: false,
          decision: "rejected",
          note: params.note,
        });
        return {
          content: [
            jsonContent({
              success: true,
              candidate_id: cand.id,
              performer_id: cand.performerId,
              name: performer.name,
              field: cand.proposedField,
              action: "reject",
              applied: false,
              decision: "rejected",
            }),
          ],
        };
      }

      // --- approve ---
      const col = FIELD_TO_COLUMN[cand.proposedField];
      if (!col) {
        return {
          content: [
            jsonContent({
              error: "field_not_applicable",
              field: cand.proposedField,
              detail: "Unknown proposed field; not applicable through this surface.",
            }),
          ],
          isError: true,
        };
      }

      const liveValue = (performer as Record<string, unknown>)[col] as string | null;
      const fillable = isEmptyFieldValue(cand.proposedField, liveValue);

      // Mark the candidate approved either way — the operator has reviewed it.
      await db
        .update(performerEnrichmentCandidates)
        .set({ decision: "approved", reviewedAt: now, reviewedBy: auth.userId })
        .where(eq(performerEnrichmentCandidates.id, cand.id));

      if (!fillable) {
        await writeAudit(db, auth, cand, {
          action: "approve",
          applied: false,
          decision: "approved",
          reason: "field_already_populated",
          note: params.note,
        });
        return {
          content: [
            jsonContent({
              success: true,
              candidate_id: cand.id,
              performer_id: cand.performerId,
              name: performer.name,
              field: cand.proposedField,
              action: "approve",
              applied: false,
              decision: "approved",
              reason: "field_already_populated",
              current_value: liveValue,
            }),
          ],
        };
      }

      // Apply the fill, then recompute enrichment from the merged final values.
      const enrichmentInput = {
        website: performer.website,
        imageUrl: performer.imageUrl,
        description: performer.description,
        socialLinks: performer.socialLinks,
        contactEmail: performer.contactEmail,
        contactPhone: performer.contactPhone,
        [col]: cand.proposedValue,
      };
      const enrichment = computePerformerEnrichment(enrichmentInput, performer.enrichmentStatus);

      await db
        .update(performers)
        .set({
          [col]: cand.proposedValue,
          enrichmentStatus: enrichment.status,
          enrichmentCoverage: enrichment.coverageJson,
          lastEnrichedAt: now,
          updatedAt: now,
        })
        .where(eq(performers.id, performer.id));

      await logEnrichment(db, {
        targetType: "performer",
        targetId: performer.id,
        source: "manual_admin",
        status: "success",
        fieldsChanged: [cand.proposedField],
        actorUserId: auth.userId,
        notes: `performer enrichment review: applied ${cand.proposedField} (candidate ${cand.id})`,
      });

      if (env) {
        // Inline ping (low performer review volume — no deferred outbox needed).
        await triggerIndexNow(
          publicUrlFor("performers", performer.slug),
          env,
          "performer-enrich-review"
        );
      }
      await writeAudit(db, auth, cand, {
        action: "approve",
        applied: true,
        decision: "approved",
        note: params.note,
      });

      return {
        content: [
          jsonContent({
            success: true,
            candidate_id: cand.id,
            performer_id: cand.performerId,
            name: performer.name,
            field: cand.proposedField,
            action: "approve",
            applied: true,
            decision: "approved",
            applied_value: cand.proposedValue,
          }),
        ],
      };
    }
  );
}

async function writeAudit(
  db: Db,
  auth: AuthContext,
  cand: typeof performerEnrichmentCandidates.$inferSelect,
  detail: {
    action: "approve" | "reject";
    applied: boolean;
    decision: string;
    reason?: string;
    note?: string;
  }
): Promise<void> {
  try {
    await db.insert(adminActions).values({
      action: "performer.enrichment_review",
      actorUserId: auth.userId,
      targetType: "performer",
      targetId: cand.performerId,
      payloadJson: JSON.stringify({
        candidate_id: cand.id,
        field: cand.proposedField,
        proposed_value: cand.proposedValue,
        flags: JSON.parse(cand.flags) as string[],
        ...detail,
      }),
      createdAt: new Date(),
    });
  } catch {
    /* audit is non-critical — never fail the review on an audit-write hiccup */
  }
}

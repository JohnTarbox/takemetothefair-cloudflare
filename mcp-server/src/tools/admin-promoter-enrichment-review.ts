/**
 * Promoter pre-extraction review surface (OPE-36) — the promoter analog of
 * admin-enrichment-review.ts.
 *
 * The nightly cron + enrich_promoter STAGE fill-empty proposals in
 * `promoter_enrichment_candidates` (dry-run by default). These two admin tools
 * let an operator drain that queue without raw SQL:
 *
 *   - `list_promoter_enrichment_candidates`  — filter/inspect staged proposals,
 *     with a summary of what's pending (clean vs flagged).
 *   - `review_promoter_enrichment_candidate` — approve one proposal (apply the
 *     value to the live promoter, fill-empty-only, then recompute
 *     enrichment_status/coverage + ping IndexNow) or reject it.
 *
 * Approve works regardless of the global ENRICHMENT_DRY_RUN switch — it's an
 * explicit human decision. The fill-empty-only contract still holds: if the
 * live field was populated since staging, approve records the decision without
 * clobbering it. Unlike the vendor surface, ALL six promoter fields (including
 * hero/logo/description) are applicable here.
 *
 * Admin only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { computePromoterEnrichment, isPlaceholderDescription } from "@takemetothefair/constants";
import { adminActions, promoterEnrichmentCandidates, promoters } from "../schema.js";
import { jsonContent, logEnrichment, publicUrlFor, triggerIndexNow } from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/** Staged-field → live promoter column. All six are applicable. */
const FIELD_TO_COLUMN: Record<string, keyof typeof promoters.$inferInsert> = {
  hero: "heroImageUrl",
  logo: "logoUrl",
  description: "description",
  social_links: "socialLinks",
  contact_email: "contactEmail",
  contact_phone: "contactPhone",
};

const PROPOSED_FIELDS = [
  "hero",
  "logo",
  "description",
  "social_links",
  "contact_email",
  "contact_phone",
] as const;

/** A promoter field is "empty" (fill-eligible) when blank; social_links also
 *  when an empty object/array literal; description also when a placeholder. */
function isEmptyFieldValue(field: string, value: string | null): boolean {
  const v = (value ?? "").trim();
  if (field === "description") return isPlaceholderDescription(value);
  if (v === "") return true;
  if (field === "social_links") return v === "{}" || v === "[]";
  return false;
}

export function registerPromoterEnrichmentReviewTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  // --- list_promoter_enrichment_candidates --------------------------------
  server.tool(
    "list_promoter_enrichment_candidates",
    "List staged promoter pre-extraction proposals from promoter_enrichment_candidates for review. Filter by decision (default 'pending'), flag status, promoter, field, or minimum confidence. Each row carries the proposed field/value, the promoter's value at proposal time, source URL, extraction method, confidence, and any safety flags. Also returns a summary of totals by decision and a clean-vs-flagged breakdown of the pending queue. Read-only. Admin only.",
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
      promoter_id: z.string().optional().describe("Restrict to a single promoter."),
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
      if (decision !== "all") conds.push(eq(promoterEnrichmentCandidates.decision, decision));
      if (params.promoter_id)
        conds.push(eq(promoterEnrichmentCandidates.promoterId, params.promoter_id));
      if (params.field) conds.push(eq(promoterEnrichmentCandidates.proposedField, params.field));
      if (typeof params.min_confidence === "number")
        conds.push(gte(promoterEnrichmentCandidates.confidence, params.min_confidence));
      if (flagged === "only") conds.push(sql`${promoterEnrichmentCandidates.flags} <> '[]'`);
      if (flagged === "clean") conds.push(eq(promoterEnrichmentCandidates.flags, "[]"));

      const rows = await db
        .select({
          id: promoterEnrichmentCandidates.id,
          promoterId: promoterEnrichmentCandidates.promoterId,
          companyName: promoters.companyName,
          field: promoterEnrichmentCandidates.proposedField,
          currentValue: promoterEnrichmentCandidates.currentValue,
          proposedValue: promoterEnrichmentCandidates.proposedValue,
          extractionMethod: promoterEnrichmentCandidates.extractionMethod,
          fetchMethod: promoterEnrichmentCandidates.fetchMethod,
          confidence: promoterEnrichmentCandidates.confidence,
          flags: promoterEnrichmentCandidates.flags,
          sourceUrl: promoterEnrichmentCandidates.sourceUrl,
          decision: promoterEnrichmentCandidates.decision,
          createdAt: promoterEnrichmentCandidates.createdAt,
          jobRunId: promoterEnrichmentCandidates.jobRunId,
        })
        .from(promoterEnrichmentCandidates)
        .leftJoin(promoters, eq(promoters.id, promoterEnrichmentCandidates.promoterId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(promoterEnrichmentCandidates.createdAt))
        .limit(limit);

      const totalsByDecision = await db
        .select({
          decision: promoterEnrichmentCandidates.decision,
          n: sql<number>`count(*)`,
        })
        .from(promoterEnrichmentCandidates)
        .groupBy(promoterEnrichmentCandidates.decision);

      const pendingSplit = await db
        .select({
          flagged: sql<number>`CASE WHEN ${promoterEnrichmentCandidates.flags} = '[]' THEN 0 ELSE 1 END`,
          n: sql<number>`count(*)`,
        })
        .from(promoterEnrichmentCandidates)
        .where(eq(promoterEnrichmentCandidates.decision, "pending"))
        .groupBy(sql`CASE WHEN ${promoterEnrichmentCandidates.flags} = '[]' THEN 0 ELSE 1 END`);

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
              promoter_id: params.promoter_id,
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
              promoter_id: r.promoterId,
              company_name: r.companyName,
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

  // --- review_promoter_enrichment_candidate -------------------------------
  server.tool(
    "review_promoter_enrichment_candidate",
    "Approve or reject one staged promoter pre-extraction proposal (by candidate id from list_promoter_enrichment_candidates). approve = apply the proposed value to the live promoter, fill-empty-only (won't clobber a field populated since the proposal was staged; a placeholder description counts as empty), then recompute enrichment_status/coverage + ping IndexNow; the candidate is marked 'approved'. reject = mark 'rejected', no promoter change. All six fields (hero, logo, description, social_links, contact_email, contact_phone) are applicable. Works regardless of the global ENRICHMENT_DRY_RUN switch. Admin only.",
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
        .from(promoterEnrichmentCandidates)
        .where(eq(promoterEnrichmentCandidates.id, params.candidate_id))
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

      const [promoter] = await db
        .select()
        .from(promoters)
        .where(eq(promoters.id, cand.promoterId))
        .limit(1);
      if (!promoter) {
        return {
          content: [jsonContent({ error: "promoter_not_found", promoter_id: cand.promoterId })],
          isError: true,
        };
      }

      const now = new Date();

      // --- reject ---
      if (params.action === "reject") {
        await db
          .update(promoterEnrichmentCandidates)
          .set({ decision: "rejected", reviewedAt: now, reviewedBy: auth.userId })
          .where(eq(promoterEnrichmentCandidates.id, cand.id));
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
              promoter_id: cand.promoterId,
              company_name: promoter.companyName,
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

      const liveValue = (promoter as Record<string, unknown>)[col] as string | null;
      const fillable = isEmptyFieldValue(cand.proposedField, liveValue);

      // Mark the candidate approved either way — the operator has reviewed it.
      await db
        .update(promoterEnrichmentCandidates)
        .set({ decision: "approved", reviewedAt: now, reviewedBy: auth.userId })
        .where(eq(promoterEnrichmentCandidates.id, cand.id));

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
              promoter_id: cand.promoterId,
              company_name: promoter.companyName,
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
        website: promoter.website,
        heroImageUrl: promoter.heroImageUrl,
        logoUrl: promoter.logoUrl,
        description: promoter.description,
        socialLinks: promoter.socialLinks,
        contactEmail: promoter.contactEmail,
        contactPhone: promoter.contactPhone,
        [col]: cand.proposedValue,
      };
      const enrichment = computePromoterEnrichment(enrichmentInput, promoter.enrichmentStatus);

      await db
        .update(promoters)
        .set({
          [col]: cand.proposedValue,
          enrichmentStatus: enrichment.status,
          enrichmentCoverage: enrichment.coverageJson,
          lastEnrichedAt: now,
          updatedAt: now,
        })
        .where(eq(promoters.id, promoter.id));

      await logEnrichment(db, {
        targetType: "promoter",
        targetId: promoter.id,
        source: "manual_admin",
        status: "success",
        fieldsChanged: [cand.proposedField],
        actorUserId: auth.userId,
        notes: `promoter enrichment review: applied ${cand.proposedField} (candidate ${cand.id})`,
      });

      if (env) {
        // Defer to the pending_search_pings outbox (batched drain) — mirrors the
        // vendor review surface so a review sweep can't trip Bing's rate limit.
        await triggerIndexNow(
          publicUrlFor("promoters", promoter.slug),
          env,
          "promoter-enrich-review",
          {
            defer: true,
            db,
            entity: { type: "promoter", id: promoter.id, slug: promoter.slug, action: "update" },
          }
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
            promoter_id: cand.promoterId,
            company_name: promoter.companyName,
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
  cand: typeof promoterEnrichmentCandidates.$inferSelect,
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
      action: "promoter.enrichment_review",
      actorUserId: auth.userId,
      targetType: "promoter",
      targetId: cand.promoterId,
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

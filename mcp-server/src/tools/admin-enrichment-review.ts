/**
 * I1 enrichment review surface (Dev-Brief-I1 §12, 2026-06-13).
 *
 * The nightly cron + post-create hook STAGE fill-empty contact proposals in
 * `vendor_enrichment_candidates` (dry-run by default). These two admin tools
 * let an operator review that queue without raw SQL and act on it:
 *
 *   - `list_enrichment_candidates`  — filter/inspect the staged proposals,
 *     with a summary of what's pending (clean vs flagged).
 *   - `review_enrichment_candidate` — approve a single proposal (apply the
 *     value to the live vendor, fill-empty-only) or reject it.
 *
 * Approve works regardless of the global ENRICHMENT_DRY_RUN switch — it's an
 * explicit human decision — so operators can cherry-pick high-confidence fills
 * during the dry-run review window and build confidence incrementally before
 * flipping on auto-merge. A human MAY approve a *flagged* candidate (manual
 * review is exactly the override path flags route to), but the fill-empty-only
 * contract is still honored: if the live vendor field has been populated since
 * the proposal was staged, approve records the decision without clobbering it.
 *
 * Admin only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { adminActions, vendorEnrichmentCandidates, vendors } from "../schema.js";
import {
  jsonContent,
  logEnrichment,
  publicUrlFor,
  recomputeVendorCompleteness,
  triggerIndexNow,
} from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

/** Staged-field → live vendor column. Mirrors applyFills() in
 *  enrichment/dispatch.ts — keep the two in sync. `description` is
 *  deliberately absent: §5 never auto-publishes prose, so it's not
 *  manually-applicable through this surface either. */
const FIELD_TO_COLUMN: Record<string, keyof typeof vendors.$inferInsert> = {
  contact_phone: "contactPhone",
  contact_email: "contactEmail",
  social_links: "socialLinks",
  address: "address",
  city: "city",
  state: "state",
};

const PROPOSED_FIELDS = [
  "contact_phone",
  "contact_email",
  "social_links",
  "address",
  "city",
  "state",
  "description",
] as const;

/** A vendor field is "empty" (fill-eligible) when blank — and, for the JSON
 *  social_links column, also when it's an empty object/array literal. */
function isEmptyFieldValue(field: string, value: string | null): boolean {
  const v = (value ?? "").trim();
  if (v === "") return true;
  if (field === "social_links") return v === "{}" || v === "[]";
  return false;
}

export function registerEnrichmentReviewTools(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  // --- list_enrichment_candidates -----------------------------------------
  server.tool(
    "list_enrichment_candidates",
    "List staged vendor-enrichment proposals from vendor_enrichment_candidates for review. Filter by decision (default 'pending'), flag status, vendor, field, or minimum confidence. Each row carries the proposed field/value, the vendor's value at proposal time, source URL, extraction method, confidence, and any safety flags. Also returns a summary of totals by decision and a clean-vs-flagged breakdown of the pending queue. Read-only. Admin only.",
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
      vendor_id: z.string().optional().describe("Restrict to a single vendor."),
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
      if (decision !== "all") conds.push(eq(vendorEnrichmentCandidates.decision, decision));
      if (params.vendor_id) conds.push(eq(vendorEnrichmentCandidates.vendorId, params.vendor_id));
      if (params.field) conds.push(eq(vendorEnrichmentCandidates.proposedField, params.field));
      if (typeof params.min_confidence === "number")
        conds.push(gte(vendorEnrichmentCandidates.confidence, params.min_confidence));
      if (flagged === "only") conds.push(sql`${vendorEnrichmentCandidates.flags} <> '[]'`);
      if (flagged === "clean") conds.push(eq(vendorEnrichmentCandidates.flags, "[]"));

      const rows = await db
        .select({
          id: vendorEnrichmentCandidates.id,
          vendorId: vendorEnrichmentCandidates.vendorId,
          businessName: vendors.businessName,
          field: vendorEnrichmentCandidates.proposedField,
          currentValue: vendorEnrichmentCandidates.currentValue,
          proposedValue: vendorEnrichmentCandidates.proposedValue,
          extractionMethod: vendorEnrichmentCandidates.extractionMethod,
          fetchMethod: vendorEnrichmentCandidates.fetchMethod,
          confidence: vendorEnrichmentCandidates.confidence,
          flags: vendorEnrichmentCandidates.flags,
          sourceUrl: vendorEnrichmentCandidates.sourceUrl,
          decision: vendorEnrichmentCandidates.decision,
          createdAt: vendorEnrichmentCandidates.createdAt,
          jobRunId: vendorEnrichmentCandidates.jobRunId,
        })
        .from(vendorEnrichmentCandidates)
        .leftJoin(vendors, eq(vendors.id, vendorEnrichmentCandidates.vendorId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(vendorEnrichmentCandidates.createdAt))
        .limit(limit);

      // Summary: totals by decision + clean/flagged split of the pending queue.
      const totalsByDecision = await db
        .select({
          decision: vendorEnrichmentCandidates.decision,
          n: sql<number>`count(*)`,
        })
        .from(vendorEnrichmentCandidates)
        .groupBy(vendorEnrichmentCandidates.decision);

      const pendingSplit = await db
        .select({
          flagged: sql<number>`CASE WHEN ${vendorEnrichmentCandidates.flags} = '[]' THEN 0 ELSE 1 END`,
          n: sql<number>`count(*)`,
        })
        .from(vendorEnrichmentCandidates)
        .where(eq(vendorEnrichmentCandidates.decision, "pending"))
        .groupBy(sql`CASE WHEN ${vendorEnrichmentCandidates.flags} = '[]' THEN 0 ELSE 1 END`);

      const pendingClean = pendingSplit.find((r) => Number(r.flagged) === 0)?.n ?? 0;
      const pendingFlagged = pendingSplit.find((r) => Number(r.flagged) === 1)?.n ?? 0;

      return {
        content: [
          jsonContent({
            count: rows.length,
            limit,
            filters: { decision, flagged, vendor_id: params.vendor_id, field: params.field },
            summary: {
              by_decision: Object.fromEntries(
                totalsByDecision.map((r) => [r.decision, Number(r.n)])
              ),
              pending_clean: Number(pendingClean),
              pending_flagged: Number(pendingFlagged),
            },
            candidates: rows.map((r) => ({
              id: r.id,
              vendor_id: r.vendorId,
              business_name: r.businessName,
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

  // --- review_enrichment_candidate ----------------------------------------
  server.tool(
    "review_enrichment_candidate",
    "Approve or reject one staged vendor-enrichment proposal (by candidate id from list_enrichment_candidates). approve = apply the proposed value to the live vendor, fill-empty-only (won't clobber a field populated since the proposal was staged), then recompute completeness + ping IndexNow; the candidate is marked 'approved'. reject = mark 'rejected', no vendor change. A flagged proposal CAN be approved — that's the manual override the flag routes to. Works regardless of the global ENRICHMENT_DRY_RUN switch. Admin only.",
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
        .from(vendorEnrichmentCandidates)
        .where(eq(vendorEnrichmentCandidates.id, params.candidate_id))
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

      const [vendor] = await db
        .select({
          id: vendors.id,
          businessName: vendors.businessName,
          slug: vendors.slug,
          deletedAt: vendors.deletedAt,
          contactPhone: vendors.contactPhone,
          contactEmail: vendors.contactEmail,
          socialLinks: vendors.socialLinks,
          address: vendors.address,
          city: vendors.city,
          state: vendors.state,
        })
        .from(vendors)
        .where(eq(vendors.id, cand.vendorId))
        .limit(1);
      if (!vendor || vendor.deletedAt) {
        return {
          content: [
            jsonContent({ error: "vendor_not_found_or_deleted", vendor_id: cand.vendorId }),
          ],
          isError: true,
        };
      }

      const now = new Date();

      // --- reject ---
      if (params.action === "reject") {
        await db
          .update(vendorEnrichmentCandidates)
          .set({ decision: "rejected", reviewedAt: now, reviewedBy: auth.userId })
          .where(eq(vendorEnrichmentCandidates.id, cand.id));
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
              vendor_id: cand.vendorId,
              business_name: vendor.businessName,
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
              detail:
                "This field is never auto-applied (e.g. description). Edit the vendor directly.",
            }),
          ],
          isError: true,
        };
      }

      const liveValue = vendor[col as keyof typeof vendor] as string | null;
      const fillable = isEmptyFieldValue(cand.proposedField, liveValue);

      // Mark the candidate approved either way — the operator has reviewed it.
      await db
        .update(vendorEnrichmentCandidates)
        .set({ decision: "approved", reviewedAt: now, reviewedBy: auth.userId })
        .where(eq(vendorEnrichmentCandidates.id, cand.id));

      if (!fillable) {
        // The live field moved on since staging — honor fill-empty-only and
        // don't clobber. The approval is still recorded (it leaves the queue).
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
              vendor_id: cand.vendorId,
              business_name: vendor.businessName,
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

      // Apply the fill.
      const update: Record<string, string> = { [col]: cand.proposedValue };
      await db.update(vendors).set(update).where(eq(vendors.id, vendor.id));

      await logEnrichment(db, {
        targetType: "vendor",
        targetId: vendor.id,
        source: "manual_admin",
        status: "success",
        fieldsChanged: [cand.proposedField],
        actorUserId: auth.userId,
        notes: `enrichment review: applied ${cand.proposedField} (candidate ${cand.id})`,
      });
      await recomputeVendorCompleteness(db, vendor.id);
      if (env) {
        await triggerIndexNow(publicUrlFor("vendors", vendor.slug), env, "vendor-enrich-review");
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
            vendor_id: cand.vendorId,
            business_name: vendor.businessName,
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
  cand: typeof vendorEnrichmentCandidates.$inferSelect,
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
      action: "vendor.enrichment_review",
      actorUserId: auth.userId,
      targetType: "vendor",
      targetId: cand.vendorId,
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

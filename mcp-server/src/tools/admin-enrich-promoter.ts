/**
 * `enrich_promoter` admin MCP tool (OPE-36) — the promoter analog of
 * enrich_vendor.
 *
 * One-off / debugging trigger for the promoter pre-extraction pipeline. Runs
 * the exact same path as the nightly queue consumer (render the promoter's
 * `website` via Browser Rendering → extract fill-empty-only signals: og:image
 * hero/logo, contact, social, description → stage proposals), but SYNCHRONOUSLY
 * and inline, so the operator sees the staged proposals in the tool response.
 *
 * Defaults to dry-run (stages to promoter_enrichment_candidates, never touches
 * the live promoter row). Pass dry_run=false to auto-apply high-confidence
 * fills (hero, single tel/mailto contact, recognized social domains,
 * non-placeholder description) and recompute enrichment_status/coverage.
 *
 * Admin only. Reuses processPromoterEnrichmentJob from
 * enrichment/promoter-dispatch.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { promoters, promoterEnrichmentCandidates, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import {
  processPromoterEnrichmentJob,
  type PromoterEnrichmentEnv,
} from "../enrichment/promoter-dispatch.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerEnrichPromoterTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env: PromoterEnrichmentEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "enrich_promoter",
    "Enrich a single promoter from its own website, synchronously. Renders the promoter's `website` via Browser Rendering, extracts fill-empty-only signals (og:image classified into a full-bleed hero band vs a square logo, contact email/phone, social links, description), and STAGES the proposals in promoter_enrichment_candidates for review. Returns the staged candidates inline. dry_run defaults true (nothing touches the live promoter row); pass dry_run=false to auto-apply high-confidence fills (hero, single tel/mailto contact, recognized social domains, non-placeholder description) and recompute enrichment_status/coverage. Use for spot-checking the pipeline on a hand-picked promoter or re-enriching after a rule change. Admin only.",
    {
      promoter_id: z.string().min(1).describe("Promoter ID (UUID)."),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Stage only (default true). false auto-applies high-confidence fills into the promoter row."
        ),
    },
    async (params) => {
      const [promoter] = await db
        .select({
          id: promoters.id,
          companyName: promoters.companyName,
          website: promoters.website,
        })
        .from(promoters)
        .where(eq(promoters.id, params.promoter_id))
        .limit(1);
      if (!promoter) {
        return {
          content: [jsonContent({ error: "promoter_not_found", promoter_id: params.promoter_id })],
          isError: true,
        };
      }

      const dryRun = params.dry_run !== false;
      const jobRunId = `manual-${crypto.randomUUID()}`;

      const summary = await processPromoterEnrichmentJob(db, env, {
        promoterId: params.promoter_id,
        jobRunId,
        dryRun,
      });

      // Pull the rows this run produced (staged or auto-merged) so the operator
      // sees exactly what was proposed.
      const candidates = await db
        .select({
          field: promoterEnrichmentCandidates.proposedField,
          currentValue: promoterEnrichmentCandidates.currentValue,
          proposedValue: promoterEnrichmentCandidates.proposedValue,
          extractionMethod: promoterEnrichmentCandidates.extractionMethod,
          confidence: promoterEnrichmentCandidates.confidence,
          flags: promoterEnrichmentCandidates.flags,
          decision: promoterEnrichmentCandidates.decision,
        })
        .from(promoterEnrichmentCandidates)
        .where(eq(promoterEnrichmentCandidates.jobRunId, jobRunId));

      // Audit (best-effort — never fail the tool on an audit-write hiccup).
      try {
        await db.insert(adminActions).values({
          action: "promoter.enrich",
          actorUserId: auth.userId,
          targetType: "promoter",
          targetId: params.promoter_id,
          payloadJson: JSON.stringify({
            jobRunId,
            dryRun,
            outcome: summary.outcome,
            candidateCount: candidates.length,
            via: "mcp",
          }),
          createdAt: new Date(),
        });
      } catch {
        /* audit is non-critical */
      }

      return {
        content: [
          jsonContent({
            success: true,
            promoter_id: params.promoter_id,
            company_name: promoter.companyName,
            dry_run: dryRun,
            outcome: summary.outcome,
            fetch_method: summary.fetchMethod ?? null,
            blocked_reason: summary.blockedReason ?? null,
            applied_fields: summary.appliedFields ?? [],
            candidate_count: candidates.length,
            candidates: candidates.map((c) => ({
              ...c,
              flags: JSON.parse(c.flags) as string[],
            })),
          }),
        ],
      };
    }
  );
}

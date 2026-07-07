/**
 * `enrich_performer` admin MCP tool (OPE-116) — the performer analog of
 * enrich_promoter.
 *
 * One-off trigger for the performer pre-extraction pipeline. Renders the
 * performer's `website` via Browser Rendering → extracts fill-empty-only signals
 * (og:image profile image, contact email/phone, social links, description) →
 * STAGES proposals in performer_enrichment_candidates. Runs SYNCHRONOUSLY so the
 * operator sees the staged proposals inline.
 *
 * Defaults to dry-run (stages only, never touches the live performer row). Pass
 * dry_run=false to auto-apply high-confidence fills (single tel/mailto contact,
 * recognized social domains, non-blank description) and recompute
 * enrichment_status/coverage. The profile IMAGE never auto-applies — it always
 * stages for review (a wrong photo is high-cost).
 *
 * Admin only. Reuses processPerformerEnrichmentJob from
 * enrichment/performer-dispatch.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { performers, performerEnrichmentCandidates, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import {
  processPerformerEnrichmentJob,
  type PerformerEnrichmentEnv,
} from "../enrichment/performer-dispatch.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerEnrichPerformerTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env: PerformerEnrichmentEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "enrich_performer",
    "Enrich a single performer (act) from its own website, synchronously. Renders the performer's `website` via Browser Rendering, extracts fill-empty-only signals (og:image profile image, contact email/phone, social links, description), and STAGES the proposals in performer_enrichment_candidates for review. Returns the staged candidates inline. dry_run defaults true (nothing touches the live performer row); pass dry_run=false to auto-apply high-confidence fills (single tel/mailto contact, recognized social domains, non-blank description) and recompute enrichment_status/coverage. The profile image NEVER auto-applies — it always stages for review. Use for spot-checking the pipeline on a hand-picked performer or re-enriching after a rule change. Admin only.",
    {
      performer_id: z.string().min(1).describe("Performer ID (UUID)."),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Stage only (default true). false auto-applies high-confidence fills into the performer row."
        ),
    },
    async (params) => {
      const [performer] = await db
        .select({
          id: performers.id,
          name: performers.name,
          website: performers.website,
        })
        .from(performers)
        .where(eq(performers.id, params.performer_id))
        .limit(1);
      if (!performer) {
        return {
          content: [
            jsonContent({ error: "performer_not_found", performer_id: params.performer_id }),
          ],
          isError: true,
        };
      }

      const dryRun = params.dry_run !== false;
      const jobRunId = `manual-${crypto.randomUUID()}`;

      const summary = await processPerformerEnrichmentJob(db, env, {
        performerId: params.performer_id,
        jobRunId,
        dryRun,
      });

      // Pull the rows this run produced (staged or auto-merged) so the operator
      // sees exactly what was proposed.
      const candidates = await db
        .select({
          field: performerEnrichmentCandidates.proposedField,
          currentValue: performerEnrichmentCandidates.currentValue,
          proposedValue: performerEnrichmentCandidates.proposedValue,
          extractionMethod: performerEnrichmentCandidates.extractionMethod,
          confidence: performerEnrichmentCandidates.confidence,
          flags: performerEnrichmentCandidates.flags,
          decision: performerEnrichmentCandidates.decision,
        })
        .from(performerEnrichmentCandidates)
        .where(eq(performerEnrichmentCandidates.jobRunId, jobRunId));

      // Audit (best-effort — never fail the tool on an audit-write hiccup).
      try {
        await db.insert(adminActions).values({
          action: "performer.enrich",
          actorUserId: auth.userId,
          targetType: "performer",
          targetId: params.performer_id,
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
            performer_id: params.performer_id,
            name: performer.name,
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

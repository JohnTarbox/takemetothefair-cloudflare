/**
 * `enrich_vendor` admin MCP tool (Dev-Brief-I1 §4 Trigger 3, 2026-06-13).
 *
 * One-off / debugging trigger for the vendor-enrichment pipeline. Runs the
 * exact same path as the nightly queue consumer (fetch the vendor's own site
 * via Browser Rendering → extract fill-empty-only contact fields → apply the
 * §5 safety rules), but SYNCHRONOUSLY and inline, so the operator sees the
 * staged proposals + flags in the tool response without waiting for the queue.
 *
 * Defaults to dry-run (stages to vendor_enrichment_candidates, never touches
 * the live vendor row). Pass dry_run=false to auto-merge un-flagged fills
 * (the Phase-2 behavior — flagged/conflict candidates always stay staged).
 *
 * Admin only. Reuses processEnrichmentJob from enrichment/dispatch.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { vendors, vendorEnrichmentCandidates, adminActions } from "../schema.js";
import { jsonContent } from "../helpers.js";
import { processEnrichmentJob, type EnrichmentEnv } from "../enrichment/dispatch.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerEnrichVendorTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env: EnrichmentEnv
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "enrich_vendor",
    "Enrich a single vendor from its own website, synchronously. Renders the vendor's `website` via Browser Rendering, extracts fill-empty-only contact fields (phone, email, social links, address), applies the I1 safety rules (drop placeholder junk, flag city/state + area-code + social-name mismatches, detect parked/for-sale/malware domains → set domain_hijacked), and STAGES the proposals in vendor_enrichment_candidates for review. Returns the staged candidates with their flags inline. dry_run defaults true (nothing touches the live vendor row); pass dry_run=false to auto-merge un-flagged fills. Use for spot-checking the pipeline on a hand-picked vendor or re-enriching after a rule change. Admin only.",
    {
      vendor_id: z.string().min(1).describe("Vendor ID (UUID)."),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "Stage only (default true). false auto-merges un-flagged fills into the vendor row."
        ),
    },
    async (params) => {
      const [vendor] = await db
        .select({ id: vendors.id, businessName: vendors.businessName, website: vendors.website })
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);
      if (!vendor) {
        return {
          content: [jsonContent({ error: "vendor_not_found", vendor_id: params.vendor_id })],
          isError: true,
        };
      }

      const dryRun = params.dry_run !== false;
      const jobRunId = `manual-${crypto.randomUUID()}`;

      const summary = await processEnrichmentJob(db, env, {
        vendorId: params.vendor_id,
        jobRunId,
        dryRun,
      });

      // Pull the rows this run produced (staged or auto-merged) so the operator
      // sees exactly what was proposed + which flags fired.
      const candidates = await db
        .select({
          field: vendorEnrichmentCandidates.proposedField,
          currentValue: vendorEnrichmentCandidates.currentValue,
          proposedValue: vendorEnrichmentCandidates.proposedValue,
          extractionMethod: vendorEnrichmentCandidates.extractionMethod,
          confidence: vendorEnrichmentCandidates.confidence,
          flags: vendorEnrichmentCandidates.flags,
          decision: vendorEnrichmentCandidates.decision,
        })
        .from(vendorEnrichmentCandidates)
        .where(eq(vendorEnrichmentCandidates.jobRunId, jobRunId));

      // Audit (best-effort — never fail the tool on an audit-write hiccup).
      try {
        await db.insert(adminActions).values({
          action: "vendor.enrich",
          actorUserId: auth.userId,
          targetType: "vendor",
          targetId: params.vendor_id,
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
            vendor_id: params.vendor_id,
            business_name: vendor.businessName,
            dry_run: dryRun,
            outcome: summary.outcome,
            fetch_method: summary.fetchMethod ?? null,
            domain_problem: summary.domainProblem ?? null,
            applied_fields: summary.appliedFields ?? [],
            vendor_flags: summary.vendorFlags ?? [],
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

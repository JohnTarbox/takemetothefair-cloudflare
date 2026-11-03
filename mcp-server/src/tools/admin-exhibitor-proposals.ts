/**
 * OPE-1139 — the operator handle on staged self-announced exhibitors.
 *
 * The inbound pipeline links an EXISTING vendor live when an exhibitor
 * announces itself ("visit us at Booth 510"), but stages a business that is not
 * yet a vendor in `exhibitor_proposals` (John, 2026-09-30, option A): a vendor
 * row is a public page, so a person decides. These two tools are that person's
 * path — list, then approve (create-or-link, strict) or reject.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { createOrLinkVendor, type VendorLinkDb } from "@takemetothefair/vendor-linking";
import { events, exhibitorProposals } from "../schema.js";
import {
  jsonContent,
  decodeHtmlEntities,
  recomputeVendorCompleteness,
  logEnrichment,
} from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

export function registerExhibitorProposalTools(server: McpServer, db: Db, auth: AuthContext): void {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "list_exhibitor_proposals",
    'OPE-1139 — businesses that announced THEMSELVES as exhibitors in a forwarded, DKIM-verified email ("visit us at Booth 510") but are not yet vendors, so the pipeline staged them instead of creating a public vendor page. Each row: the event, the business name and website read from the original sender, booth, the phrase that triggered it, and the inbound email it came from. Approve or reject with review_exhibitor_proposal. Admin only. Read-only.',
    {
      status: z
        .enum(["pending", "approved", "rejected", "all"])
        .optional()
        .default("pending")
        .describe("pending (default) = awaiting a decision."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(25)
        .describe("Max rows (default 25)."),
    },
    async (params) => {
      const rows = await db
        .select({
          id: exhibitorProposals.id,
          status: exhibitorProposals.status,
          eventId: exhibitorProposals.eventId,
          eventSlug: events.slug,
          eventName: events.name,
          businessName: exhibitorProposals.businessName,
          website: exhibitorProposals.website,
          senderAddress: exhibitorProposals.senderAddress,
          city: exhibitorProposals.city,
          state: exhibitorProposals.state,
          boothInfo: exhibitorProposals.boothInfo,
          evidence: exhibitorProposals.evidence,
          inboundEmailId: exhibitorProposals.inboundEmailId,
          resolvedVendorId: exhibitorProposals.resolvedVendorId,
          resolutionNote: exhibitorProposals.resolutionNote,
          createdAt: exhibitorProposals.createdAt,
          resolvedAt: exhibitorProposals.resolvedAt,
        })
        .from(exhibitorProposals)
        .leftJoin(events, eq(events.id, exhibitorProposals.eventId))
        .where(params.status === "all" ? undefined : eq(exhibitorProposals.status, params.status))
        .orderBy(desc(exhibitorProposals.createdAt))
        .limit(params.limit);
      return {
        content: [jsonContent({ count: rows.length, status: params.status, proposals: rows })],
      };
    }
  );

  server.tool(
    "review_exhibitor_proposal",
    "OPE-1139 — decide a staged self-announced exhibitor. approve: create-or-link the vendor with STRICT dedup (an existing vendor of the same name is linked, never duplicated) and link it to the event as EXHIBITOR / CONFIRMED with the staged booth — this creates a PUBLIC vendor page when the business is new. reject: mark it rejected; nothing is written to vendors. Pass business_name to correct the name before approving (required when the staged row has none). Admin only.",
    {
      proposal_id: z
        .string()
        .min(1)
        .describe("exhibitor_proposals.id from list_exhibitor_proposals."),
      decision: z.enum(["approve", "reject"]),
      business_name: z
        .string()
        .min(1)
        .max(200)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Corrected business name. Required on approve when the staged row has none."),
      note: z
        .string()
        .max(500)
        .transform(decodeHtmlEntities)
        .optional()
        .describe("Why — stored on the row."),
    },
    async (params) => {
      const [p] = await db
        .select()
        .from(exhibitorProposals)
        .where(eq(exhibitorProposals.id, params.proposal_id))
        .limit(1);
      if (!p) return { content: [jsonContent({ ok: false, error: "proposal not found" })] };
      if (p.status !== "pending") {
        return {
          content: [
            jsonContent({
              ok: false,
              error: `already ${p.status}`,
              resolved_vendor_id: p.resolvedVendorId,
            }),
          ],
        };
      }

      if (params.decision === "reject") {
        await db
          .update(exhibitorProposals)
          .set({ status: "rejected", resolutionNote: params.note ?? null, resolvedAt: new Date() })
          .where(and(eq(exhibitorProposals.id, p.id), eq(exhibitorProposals.status, "pending")));
        return { content: [jsonContent({ ok: true, proposal_id: p.id, status: "rejected" })] };
      }

      const businessName = params.business_name ?? p.businessName;
      if (!businessName) {
        return {
          content: [
            jsonContent({
              ok: false,
              error: "this proposal has no business name; pass business_name to approve",
            }),
          ],
        };
      }
      const res = await createOrLinkVendor(
        db as unknown as VendorLinkDb,
        {
          eventId: p.eventId,
          businessName,
          dedupStrategy: "strict",
          status: "CONFIRMED",
          participationType: "EXHIBITOR",
          boothInfo: p.boothInfo,
          website: p.website,
          city: p.city,
          state: p.state,
        },
        { actorUserId: auth.userId ?? null, recomputeVendorCompleteness, logEnrichment }
      );
      if (!res.ok) return { content: [jsonContent({ ok: false, error: res.error })] };
      await db
        .update(exhibitorProposals)
        .set({
          status: "approved",
          resolvedVendorId: res.vendorId,
          resolutionNote: params.note ?? null,
          resolvedAt: new Date(),
        })
        .where(and(eq(exhibitorProposals.id, p.id), eq(exhibitorProposals.status, "pending")));
      return {
        content: [
          jsonContent({
            ok: true,
            proposal_id: p.id,
            status: "approved",
            vendor_id: res.vendorId,
            vendor_slug: res.vendorSlug,
            vendor_created: res.wasCreated,
            linked: res.wasLinked || res.wasAlreadyLinked,
            booth_info: p.boothInfo,
          }),
        ],
      };
    }
  );
}

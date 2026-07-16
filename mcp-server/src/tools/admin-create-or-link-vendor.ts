/**
 * MCP `create_or_link_vendor` — a thin adapter over the shared write tail in
 * `@takemetothefair/vendor-linking`. The dedup → create → link → audit logic
 * lives in that package (one copy, also called by the app); this file is just
 * the tool contract (Zod), MCP result shape, and the two cosmetic side-effects
 * (IndexNow ping + post-create enrichment enqueue) that are MCP-runtime-specific.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PARTICIPATION_TYPE_ENUM,
  PAYMENT_STATUS_ENUM,
  VENDOR_STATUS_ENUM,
  jsonContent,
  logEnrichment,
  publicUrlFor,
  recomputeVendorCompleteness,
  sanitizeProse,
  triggerIndexNow,
} from "../helpers.js";
import {
  createOrLinkVendor,
  DEDUP_STRATEGY_VALUES,
  type CreateOrLinkVendorInput,
} from "@takemetothefair/vendor-linking";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import type { VendorEnrichmentMessage } from "../enrichment/dispatch.js";

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
  VENDOR_ENRICHMENT?: { send: (msg: VendorEnrichmentMessage) => Promise<unknown> };
  ENRICHMENT_DRY_RUN?: string;
}

export function registerCreateOrLinkVendorTool(
  server: McpServer,
  db: Db,
  auth: AuthContext,
  env?: Env
) {
  if (auth.role !== "ADMIN") return;

  server.tool(
    "create_or_link_vendor",
    "Dedup-search, create-if-needed, and link vendor to event in a single call. Combines search_vendors + create_vendor + update_vendor_status. Admin only.",
    {
      event_id: z.string().describe("Event ID to link the vendor to"),
      business_name: z
        .string()
        .min(1)
        .max(200)
        .transform(sanitizeProse)
        .describe("Business/organization name"),
      type: z
        .string()
        .max(100)
        .transform(sanitizeProse)
        .optional()
        .describe("Vendor category (used for new-vendor creation and fuzzy-match weighting)"),
      status: z
        .enum(VENDOR_STATUS_ENUM)
        .optional()
        .default("CONFIRMED")
        .describe("Event-vendor link status (default CONFIRMED)"),
      description: z.string().max(500).transform(sanitizeProse).optional(),
      products: z.array(z.string().transform(sanitizeProse)).optional(),
      location: z.string().optional().describe("City and state, e.g. 'Portland, ME'"),
      website: z.string().optional(),
      contact_email: z.string().optional(),
      contact_phone: z.string().optional(),
      logo_url: z.string().optional(),
      dedup_strategy: z
        .enum(DEDUP_STRATEGY_VALUES)
        .optional()
        .default("fuzzy")
        .describe(
          "How to look for an existing vendor. 'strict' = case-insensitive exact match; 'fuzzy' = Levenshtein+Jaccard ≥ 0.92; 'skip' = no dedup, always create."
        ),
      booth_info: z.string().max(200).optional(),
      payment_status: z
        .enum(PAYMENT_STATUS_ENUM)
        .optional()
        .default("NOT_REQUIRED")
        .describe("Payment status on the event_vendors link"),
      participation_type: z
        .enum(PARTICIPATION_TYPE_ENUM)
        .optional()
        .default("EXHIBITOR")
        .describe(
          "Participation mode on the event_vendors link. EXHIBITOR = takes booth space (default); SPONSOR_ONLY = logo/program presence, no booth; SPONSOR_AND_EXHIBITOR = both (e.g. venue naming rights + a booth on the floor)."
        ),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "REL4: defaults TRUE — queue the IndexNow ping in pending_search_pings (drained by the hourly cron / flush_pending_search_pings) instead of firing inline, to avoid Bing's per-host 429 storm. Pass false only when this single write needs immediate indexing."
        ),
      event_day_id: z
        .string()
        .optional()
        .nullable()
        .describe(
          "K18 Phase 1: optional per-occurrence scoping for recurring-event series. Omitted / null → series-wide (regular participant, applies to every occurrence — default, preserves pre-K18 behavior). Set → vendor participates on THIS event_day only. The id MUST belong to an event_day of `event_id`; cross-event ids are rejected. A vendor linked both series-wide AND on a specific date is allowed."
        ),
    },
    async (params) => {
      const deferSearchPing = params.defer_search_ping ?? true;

      const input: CreateOrLinkVendorInput = {
        eventId: params.event_id,
        businessName: params.business_name,
        type: params.type ?? null,
        status: params.status,
        description: params.description ?? null,
        products: params.products ?? null,
        location: params.location ?? null,
        website: params.website ?? null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
        logoUrl: params.logo_url ?? null,
        dedupStrategy: params.dedup_strategy,
        boothInfo: params.booth_info ?? null,
        paymentStatus: params.payment_status,
        participationType: params.participation_type,
        eventDayId: params.event_day_id ?? null,
      };

      const result = await createOrLinkVendor(db, input, {
        actorUserId: auth.userId,
        recomputeVendorCompleteness,
        logEnrichment,
      });

      if (!result.ok) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }

      // Cosmetic side-effects — MCP-runtime-specific, driven by the core's flags.
      // When defer_search_ping is true the helper queues rows in
      // pending_search_pings instead of firing IndexNow inline.
      if (env) {
        if (result.wasCreated) {
          await triggerIndexNow(
            publicUrlFor("vendors", result.vendorSlug),
            env,
            "vendor-create-or-link",
            {
              defer: deferSearchPing,
              db,
              entity: {
                type: "vendor",
                id: result.vendorId,
                slug: result.vendorSlug,
                action: "create",
              },
            }
          );

          // I1 — kick a fill-empty enrichment pass for the fresh vendor so its
          // contact fields populate without waiting for the nightly cron.
          // Fire-and-forget: a queue hiccup must never fail the create.
          const website = params.website?.trim();
          if (website && env.VENDOR_ENRICHMENT) {
            try {
              await env.VENDOR_ENRICHMENT.send({
                vendorId: result.vendorId,
                jobRunId: `postcreate-${result.vendorId}`,
                dryRun: env.ENRICHMENT_DRY_RUN !== "false",
              });
            } catch {
              /* best-effort — the nightly cron will pick this vendor up */
            }
          }
        }
        if (result.linkIsPublic) {
          await triggerIndexNow(
            publicUrlFor("events", result.eventSlug),
            env,
            "event-vendor-link",
            {
              defer: deferSearchPing,
              db,
              entity: {
                type: "event",
                id: params.event_id,
                slug: result.eventSlug,
                action: "update",
              },
            }
          );
        }
      }

      return {
        content: [
          jsonContent({
            vendor_id: result.vendorId,
            was_created: result.wasCreated,
            was_linked: result.wasLinked,
            was_already_linked: result.wasAlreadyLinked,
            status_changed: result.statusChanged,
            matched_existing: result.matchedExisting,
          }),
        ],
      };
    }
  );
}

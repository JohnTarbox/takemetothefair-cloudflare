import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, like, inArray, isNull, sql } from "drizzle-orm";
import {
  events,
  eventVendors,
  vendors,
  venues,
  promoters,
  users,
  eventDays,
  vendorSlugHistory,
  eventSlugHistory,
  adminActions,
  eventDataCitations,
} from "../schema.js";
import {
  formatDateRange,
  parseJsonArray,
  escapeLike,
  jsonContent,
  createSlug,
  appendSlugSegment,
  unsafeSlug,
  type Slug,
  parseLocation,
  sanitizeProse,
  coerceVenueNameAtIngest,
  VALID_TRANSITIONS,
} from "../helpers.js";
import { checkDuplicateViaMainApp } from "../duplicates/check-duplicate.js";
import {
  EVENT_STATUS_ENUM,
  VENDOR_STATUS_ENUM,
  PAYMENT_STATUS_ENUM,
  PARTICIPATION_TYPE_ENUM,
  computePublicDates,
  publicUrlFor,
  triggerIndexNow,
  PUBLIC_EVENT_STATUSES,
  PUBLIC_VENDOR_STATUSES,
  recomputeVendorCompleteness,
  recomputeEventCompleteness,
  logEnrichment,
} from "../helpers.js";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";
import { loadClassifications, gateUrlForField } from "../url-classification.js";
import { evaluateGates, normalizeEventDate } from "@takemetothefair/utils";
import {
  eventOutboxStatements,
  venueOutboxStatements,
  eventDayOutboxStatements,
  enqueueSyndicationChange,
} from "../syndication/outbox.js";
import { PRIMARY_AUDIENCE, PUBLIC_ACCESS } from "@takemetothefair/constants";
import { dollarsToCents } from "../helpers.js";
import { notifyApprovalIfNeeded } from "../approval-notification.js";
import { registerCreateOrLinkVendorTool } from "./admin-create-or-link-vendor.js";
import { registerFlushPendingSearchPingsTool } from "./admin-flush-pending-search-pings.js";
import { registerSitemapResubmitTool } from "./admin-sitemap-resubmit.js";
import { registerRequestIndexingTool } from "./admin-request-indexing.js";
import { registerAdminClaimApprovalTool } from "./admin-claim-approval.js";
import { registerEventLifecycleTools } from "./admin-event-lifecycle.js";
import { registerRecommendationsTools } from "./admin-recommendations.js";
import { registerUploadImageBytesTool } from "./upload-image-bytes.js";
import { registerRequestImageUploadSlotTool } from "./request-image-upload-slot.js";
import { registerEmailSenderTools } from "./admin-email-senders.js";
import { registerSalvageInboundEmailTool } from "./admin-salvage-inbound-email.js";
import { registerOgImageSweepTool } from "./admin-og-image-sweep.js";
import { registerSourceQualityTool } from "./admin-source-quality.js";
import { registerSourceReliabilityTool } from "./admin-source-reliability.js";
import { registerDiscrepancyTools } from "./admin-discrepancies.js";
import { registerDataHealthTool } from "./admin-data-health.js";
import { registerLogVendorOutreachTool } from "./admin-log-vendor-outreach.js";
import {
  registerCitationTools,
  DENORM_FIELD_MAP as CITATION_DENORM_FIELD_MAP,
  SOURCE_TYPE_VALUES as CITATION_SOURCE_TYPE_VALUES,
} from "./admin-citations.js";

const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_EVENT_STATUSES);
const PUBLIC_VENDOR_SET = new Set<string>(PUBLIC_VENDOR_STATUSES);

interface Env {
  MAIN_APP_URL: string;
  INTERNAL_API_KEY: string;
  /** EMAIL_JOBS queue producer for the approval-notification hook on
   *  PENDING/TENTATIVE → APPROVED transitions in update_event_status.
   *  Optional so dev / unconfigured environments degrade gracefully. */
  EMAIL_JOBS?: Queue<unknown>;
  /** SYN1 (2026-06-12) — syndication trigger producer; the update_* tools
   *  enqueue after a mirrored-field correction. Optional like EMAIL_JOBS. */
  SYNDICATION_CHANGES?: Queue<unknown>;
  /** I1 Trigger 1 (2026-06-13) — vendor-enrichment queue producer; the
   *  create_or_link_vendor post-create hook enqueues a fill-empty pass for a
   *  newly-created vendor. Optional like EMAIL_JOBS. */
  VENDOR_ENRICHMENT?: Queue<unknown>;
  /** I1 dry-run switch, passed through to the post-create hook so it mirrors
   *  the cron/queue path. "false" flips off the Phase-1 dry-run default. */
  ENRICHMENT_DRY_RUN?: string;
}

export function registerAdminTools(server: McpServer, db: Db, auth: AuthContext, env?: Env) {
  // Defense-in-depth: guard even though registration is already gated in index.ts
  if (auth.role !== "ADMIN") return;

  // Combined dedup + create + link tool — separate file to keep this one
  // manageable.
  registerCreateOrLinkVendorTool(server, db, auth, env);

  // Outbox drainer for the defer_search_ping flag — fires one batched
  // IndexNow call instead of N inline pings after a bulk ingestion run.
  registerFlushPendingSearchPingsTool(server, db, auth, env);

  // Google Search Console sitemap resubmit. Pairs with the post-bulk-
  // ingest workflow — nudges Google to recrawl a sitemap ahead of its
  // default multi-day cadence.
  registerSitemapResubmitTool(server, db, auth, env);

  // Google Indexing API per-URL recrawl notification. Use sparingly on
  // high-value pages stuck in "Discovered – not indexed" or fresh slug
  // renames; the API officially scopes to JobPosting / BroadcastEvent
  // but empirically accepts other URL types as recrawl signals.
  registerRequestIndexingTool(server, db, auth, env);

  // Manual claim approval — escape hatch for vendors whose
  // contact_email is null/empty and can't go through the standard
  // email-match or claim-confirmation flows. Admin verifies ownership
  // out-of-band, then runs this tool to set claimed=true + grant
  // VENDOR role.
  registerAdminClaimApprovalTool(server, db, auth);

  // Sender-quality + trust annotation for inbound email submissions
  // (drizzle/0075). Adds get_email_submitter_quality (read) and
  // set_email_sender_trust (write).
  registerEmailSenderTools(server, db, auth);

  // event_data_citations provenance tooling (drizzle/0064). Adds
  // create_event_citation, list_event_citations, update_event_citation,
  // delete_event_citation, bulk_create_event_citations.
  registerCitationTools(server, db, auth, env);

  // Event lifecycle transitions (drizzle/0067). Adds update_event_lifecycle
  // with transition validation, date-swap for RESCHEDULED/POSTPONED,
  // admin_actions audit logging, and IndexNow on visibility crossings.
  registerEventLifecycleTools(server, db, auth, env);

  // Read-only recommendations feed — same data as /admin/analytics ▸
  // Recommendations. Adds get_recommendations, get_recommendation_rule.
  // Dispositions (snooze/dismiss) stay in the admin UI by design.
  registerRecommendationsTools(server, db, auth);

  // Direct base64 image upload (no source URL required). Adds
  // upload_image_bytes. Generic across event/vendor/venue. Phase 1 stores
  // bytes as-is; Phase 2 will add server-side optimization.
  registerUploadImageBytesTool(server, auth, env);

  // K17 (2026-06-07): one-shot upload-slot tool. Returns a URL the
  // model's local HTTP client can POST raw bytes to, sidestepping the
  // ~500KB ceiling on base64-in-tool-argument that upload_image_bytes
  // hits when the model balks at emitting long arg strings. Pairs with
  // /api/admin/upload-image-slot + /api/admin/upload-image-direct/[token]
  // on the main app; bytes flow Claude Desktop → main app directly,
  // never round-tripping through the MCP channel.
  registerRequestImageUploadSlotTool(server, auth, env);

  // Analyst F1 (2026-05-29): MCP wrappers for three highest-leverage
  // admin endpoints added in the 5/26 mega-shipment. Each one lets Claude
  // drive an operation that previously required a NextAuth-session
  // browser hop. Inputs follow the same parameter shapes the analyst's
  // backlog item asked for.
  registerSalvageInboundEmailTool(server, auth, env);
  registerOgImageSweepTool(server, auth, env);
  registerSourceQualityTool(server, db, auth);
  // GW1c (2026-06-02): cross-link sibling to source-quality. Backed by
  // mcp-server/src/goodwill/scoring.ts which the GW1d resolve_discrepancy
  // tool fires to write source_reliability rows.
  registerSourceReliabilityTool(server, db, auth);

  // GW1d (2026-06-02): the goodwill-engine outreach queue's CRUD
  // surface. list_event_discrepancies + resolve_discrepancy +
  // create_discrepancy + rerank_outreach_queue.
  registerDiscrepancyTools(server, db, auth);

  // GW1e (2026-06-02): CPI report-card. Surfaces queue health +
  // reliability matrix + 28-day resolution metrics + 14-day snapshot
  // trend. Phase-2-only metrics stub as 'Awaiting Phase 2' per B8.
  registerDataHealthTool(server, db, auth);

  // Analyst J1 (2026-05-29 PM): outreach-attempt logging substrate for
  // /admin/vendor-claim-leaderboard. MCP-exposed so Cowork can log
  // attempts without going through the browser UI.
  registerLogVendorOutreachTool(server, db, auth);

  // ── list_all_events ────────────────────────────────────────────
  // Whitelist of event fields that can be filtered for NULL values
  const MISSING_FIELD_MAP: Record<string, any> = {
    venue_id: events.venueId,
    description: events.description,
    image_url: events.imageUrl,
    start_date: events.startDate,
    end_date: events.endDate,
    ticket_url: events.ticketUrl,
    source_url: events.sourceUrl,
    categories: events.categories,
    tags: events.tags,
    vendor_fee: events.vendorFeeMinCents,
    indoor_outdoor: events.indoorOutdoor,
    event_scale: events.eventScale,
    application_url: events.applicationUrl,
  };

  server.tool(
    "list_all_events",
    "Browse/search all events regardless of promoter ownership. Use missing_fields to find events with incomplete data (e.g. no venue, no image). Admin only.",
    {
      status: z.enum(EVENT_STATUS_ENUM).optional().describe("Filter by event status"),
      state: z
        .string()
        .optional()
        .describe("Filter by venue state (2-letter code, e.g. 'ME', 'VT')"),
      search: z.string().optional().describe("Search events by name (partial match)"),
      missing_fields: z
        .array(
          z.enum([
            "venue_id",
            "description",
            "image_url",
            "start_date",
            "end_date",
            "ticket_url",
            "source_url",
            "categories",
            "tags",
            "vendor_fee",
            "indoor_outdoor",
            "event_scale",
            "application_url",
          ])
        )
        .optional()
        .describe(
          "Filter for events where these fields are NULL/missing. E.g. ['venue_id','image_url'] returns events with no venue AND no image."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return (default 20)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      const conditions = [];
      if (params.status) {
        conditions.push(eq(events.status, params.status));
      }
      if (params.search) {
        conditions.push(like(events.name, `%${escapeLike(params.search)}%`));
      }
      if (params.state) {
        conditions.push(sql`upper(${venues.state}) = upper(${params.state})`);
      }
      if (params.missing_fields) {
        for (const field of params.missing_fields) {
          const column = MISSING_FIELD_MAP[field];
          if (column) {
            conditions.push(isNull(column));
          }
        }
      }

      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;

      const query = db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          status: events.status,
          featured: events.featured,
          categories: events.categories,
          imageUrl: events.imageUrl,
          venueId: events.venueId,
          venueName: venues.name,
          venueCity: venues.city,
          venueState: venues.state,
          promoterId: events.promoterId,
          promoterName: promoters.companyName,
        })
        .from(events)
        .leftJoin(venues, eq(events.venueId, venues.id))
        .leftJoin(promoters, eq(events.promoterId, promoters.id));

      const eventRows =
        conditions.length > 0
          ? await query
              .where(and(...conditions))
              .limit(limit)
              .offset(offset)
          : await query.limit(limit).offset(offset);

      // Batch-fetch vendor counts per event
      const eventIds = eventRows.map((e) => e.id);
      const vendorCounts: Record<string, { total: number; applied: number; confirmed: number }> =
        {};

      if (eventIds.length > 0) {
        const allApps = await db
          .select({
            eventId: eventVendors.eventId,
            status: eventVendors.status,
          })
          .from(eventVendors)
          .where(inArray(eventVendors.eventId, eventIds));

        for (const app of allApps) {
          if (!vendorCounts[app.eventId]) {
            vendorCounts[app.eventId] = { total: 0, applied: 0, confirmed: 0 };
          }
          vendorCounts[app.eventId].total++;
          if (app.status === "APPLIED") vendorCounts[app.eventId].applied++;
          if (app.status === "CONFIRMED" || app.status === "APPROVED")
            vendorCounts[app.eventId].confirmed++;
        }
      }

      const output = eventRows.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        dates: formatDateRange(e.startDate, e.endDate),
        status: e.status,
        featured: e.featured,
        venue_id: e.venueId || null,
        location: [e.venueName, e.venueCity, e.venueState].filter(Boolean).join(", ") || "TBD",
        image_url: e.imageUrl || null,
        promoter_id: e.promoterId,
        promoter: e.promoterName || "Unknown",
        categories: parseJsonArray(e.categories),
        vendors: vendorCounts[e.id] || { total: 0, applied: 0, confirmed: 0 },
      }));

      return {
        content: [
          jsonContent({
            count: output.length,
            offset,
            has_more: output.length === limit,
            events: output,
          }),
        ],
      };
    }
  );

  // ── update_event_status ────────────────────────────────────────
  server.tool(
    "update_event_status",
    "Approve, reject, or change any event's status. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      status: z.enum(EVENT_STATUS_ENUM).describe("New event status"),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      const eventRows = await db
        .select({
          id: events.id,
          name: events.name,
          slug: events.slug,
          status: events.status,
        })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found." }],
          isError: true,
        };
      }

      const event = eventRows[0];
      const previousStatus = event.status;

      if (previousStatus === params.status) {
        return {
          content: [{ type: "text", text: `Event is already ${params.status}.` }],
          isError: true,
        };
      }

      await db
        .update(events)
        .set({ status: params.status, updatedAt: new Date() })
        .where(eq(events.id, event.id));

      // Audit log — material status transitions need to land in admin_actions
      // so the Analytics activity feed and any downstream auditing can see
      // them. Pattern mirrors set_enhanced_profile in this file.
      await db.insert(adminActions).values({
        action: "event.status_change",
        actorUserId: auth.userId,
        targetType: "event",
        targetId: event.id,
        payloadJson: JSON.stringify({
          previous_status: previousStatus,
          new_status: params.status,
          slug: event.slug,
        }),
        createdAt: new Date(),
      });

      // IndexNow: distinguish first-publish from the TENTATIVE→APPROVED
      // upgrade — both transitions matter to the analytics tab. A bare
      // public-bucket guard misses TENTATIVE→APPROVED because both are public.
      if (env) {
        const wasPublic = PUBLIC_EVENT_SET.has(previousStatus);
        const isPublic = PUBLIC_EVENT_SET.has(params.status);
        let source: string | null = null;
        if (!wasPublic && isPublic) {
          source = "event-create";
        } else if (previousStatus === "TENTATIVE" && params.status === "APPROVED") {
          source = "event-approve";
        }
        if (source) {
          await triggerIndexNow(publicUrlFor("events", event.slug), env, source, {
            defer: params.defer_search_ping ?? false,
            db,
            entity: { type: "event", id: event.id, slug: event.slug, action: "status_change" },
          });
        }
      }

      // Approval-notification hook — fires on non-APPROVED → APPROVED
      // transitions for submitter-attributed events. Helper gates on
      // suggester_email present + approval_notified_at NULL, so admin-
      // created events (no submitter) and re-approvals are correctly
      // skipped. Non-blocking on failure: log + continue rather than
      // failing the admin tool call.
      if (previousStatus !== "APPROVED" && params.status === "APPROVED") {
        try {
          const result = await notifyApprovalIfNeeded(
            db,
            { EMAIL_JOBS: env?.EMAIL_JOBS },
            event.id
          );
          if (result.outcome.startsWith("error:")) {
            console.warn(
              `[MCP/update_event_status] approval notify ${result.outcome} for ${event.id}`
            );
          }
        } catch (notifyError) {
          console.error(
            `[MCP/update_event_status] approval notify failed for ${event.id}:`,
            notifyError
          );
        }
      }

      return {
        content: [
          jsonContent({
            updated: true,
            event: { id: event.id, name: event.name, previousStatus, newStatus: params.status },
          }),
        ],
      };
    }
  );

  // ── update_event ───────────────────────────────────────────────
  server.tool(
    "update_event",
    "Update event fields (name, description, dates, venue, ticket info, source info, image, etc.). Does NOT change status — use update_event_status for that. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      name: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Event name (also regenerates slug unless `slug` is explicitly set)"),
      slug: z
        .string()
        .optional()
        .describe(
          "Custom slug. When provided, takes priority over the name-derived slug. The old slug is captured in event_slug_history for 301-redirect. Mirrors update_vendor.slug."
        ),
      description: z.string().transform(sanitizeProse).optional().describe("Event description"),
      start_date: z.string().optional().describe("Start date as ISO 8601 string"),
      end_date: z.string().optional().describe("End date as ISO 8601 string"),
      dates_confirmed: z.boolean().optional().describe("Whether dates are confirmed"),
      venue_id: z.string().optional().describe("Venue ID (FK to venues table)"),
      promoter_id: z.string().optional().describe("Promoter ID (FK to promoters table)"),
      categories: z
        .array(z.string())
        .optional()
        .describe("Category list, e.g. ['Craft Fair','Market']"),
      tags: z.array(z.string()).optional().describe("Tag list, e.g. ['family-friendly','outdoor']"),
      ticket_url: z.string().optional().describe("URL to buy tickets"),
      ticket_price_min: z.number().optional().describe("Minimum ticket price"),
      ticket_price_max: z.number().optional().describe("Maximum ticket price"),
      image_url: z.string().optional().describe("Event image URL"),
      // IMG1 §1b Phase 1 (2026-06-08) — per-image focal point. Range
      // [0, 1] matching Cloudflare's gravity=XxY (0,0 = top-left).
      // Default (0.5, 0.5) = center. Card thumbnails crop around this
      // point. Use to rescue posters where center-crop chops the title.
      // Mirrors the admin-UI FocalPointPicker; same Zod validation.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Horizontal focal point for card crops, 0–1 (0=left, 0.5=center, 1=right). Default 0.5."
        ),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Vertical focal point for card crops, 0–1 (0=top, 0.5=center, 1=bottom). Default 0.5."
        ),
      featured: z.boolean().optional().describe("Whether the event is featured"),
      commercial_vendors_allowed: z
        .boolean()
        .optional()
        .describe("Whether commercial vendors are allowed"),
      vendor_fee_min: z.number().optional().describe("Minimum vendor/booth fee"),
      vendor_fee_max: z.number().optional().describe("Maximum vendor/booth fee"),
      vendor_fee_notes: z.string().optional().describe("Details about vendor/booth fees"),
      indoor_outdoor: z
        .enum(["INDOOR", "OUTDOOR", "MIXED"])
        .optional()
        .describe("Indoor/outdoor designation"),
      estimated_attendance: z.number().int().optional().describe("Expected attendance count"),
      event_scale: z
        .enum(["SMALL", "MEDIUM", "LARGE", "MAJOR"])
        .optional()
        .describe("Event scale category"),
      application_deadline: z
        .string()
        .optional()
        .describe("Vendor application deadline (ISO 8601)"),
      application_url: z.string().optional().describe("URL for vendor applications"),
      application_instructions: z.string().optional().describe("How to apply as a vendor"),
      walk_ins_allowed: z.boolean().optional().describe("Whether walk-in vendors are accepted"),
      // TAX1 Phase 1 (2026-06-02) — audience / access taxonomy. These
      // are attributes, NOT structural tracked fields, so they do
      // NOT participate in the citation denorm map at
      // admin-citations.ts. Per A4 of the spec.
      primary_audience: z
        .enum(PRIMARY_AUDIENCE)
        .optional()
        .describe(
          "Who the event is ORIENTED toward. PUBLIC = general public; TRADE = industry / B2B; MEMBERS = association / club. Orthogonal to public_access."
        ),
      public_access: z
        .enum(PUBLIC_ACCESS)
        .optional()
        .describe(
          "Can a non-member of the public attend at all? OPEN = yes (may still require ticket); CLOSED = no. A TRADE+OPEN event means the public can pay in."
        ),
      access_notes: z
        .string()
        .max(1000)
        .transform(sanitizeProse)
        .optional()
        .describe(
          "Free-text nuance the audience+access pair can't hold (e.g. 'Members + public for the Saturday plant sale 9am-1pm')."
        ),
      registration_required: z
        .boolean()
        .optional()
        .describe(
          "True when advance registration is required to attend. Separate axis from audience/access."
        ),
      source_url: z.string().optional().describe("Original source URL"),
      source_id: z.string().optional().describe("ID in the source system"),
      source_name: z
        .string()
        .optional()
        .describe("Name of the source (e.g. 'facebook', 'eventbrite')"),
      recurrence_rule: z.string().optional().describe("iCal RRULE recurrence string"),
      discontinuous_dates: z
        .boolean()
        .optional()
        .describe("Whether the event has non-consecutive dates"),
      sync_enabled: z.boolean().optional().describe("Whether automated sync is enabled"),
      venue_name: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Update linked venue's name (convenience shortcut)"),
      venue_address: z.string().optional().describe("Update linked venue's street address"),
      venue_city: z.string().optional().describe("Update linked venue's city"),
      venue_state: z.string().optional().describe("Update linked venue's state (2-letter code)"),
      venue_zip: z.string().optional().describe("Update linked venue's ZIP code"),
      is_statewide: z
        .boolean()
        .optional()
        .describe(
          "Mark event as statewide (no single venue, e.g. Maine Maple Sunday). When true, also set state_code; venue_id is typically cleared in a separate call."
        ),
      state_code: z
        .string()
        .length(2)
        .optional()
        .describe(
          "2-letter state code (uppercased automatically). Required pairing for statewide events; also valid for venue-anchored events as a denormalized convenience."
        ),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
      acknowledge_possible_duplicates: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Set to true to suppress the venue+date duplicate-detection warning. Use only after manually verifying that the events flagged in a prior call's `warnings.possible_duplicates` array are NOT actually the same event. Default false: the call returns a warning (not an error) listing potential duplicates so the caller can review."
        ),
      // Optional provenance for tracked fields. When supplied AND any of
      // estimated_attendance / vendor_fee_min / vendor_fee_max /
      // ticket_price_min / ticket_price_max / application_deadline is being
      // changed in this call, a citation row is inserted for each tracked
      // field touched (auto-superseding the prior active row for the same
      // (event, field, year) tuple). Omitting `citation` keeps existing
      // behavior — column writes proceed with no provenance row recorded.
      citation: z
        .object({
          source_url: z.string().url(),
          source_type: z.enum(CITATION_SOURCE_TYPE_VALUES),
          source_name: z.string().max(200).transform(sanitizeProse).optional(),
          year: z.number().int().min(1900).max(2100).optional(),
          confidence: z.number().min(0).max(1).optional(),
          notes: z.string().max(1000).transform(sanitizeProse).optional(),
        })
        .optional()
        .describe(
          "Provenance for tracked-field changes (estimated_attendance, vendor_fee_min/max, ticket_price_min/max, application_deadline, start_date, end_date, venue_id, name). When set, one citation row is inserted per tracked field touched. K4 (2026-05-31) extended this to the structural fields (dates/venue/name) — the highest-stakes data on the site MUST carry an auditable source URL."
        ),
    },
    async (params) => {
      // Load URL domain classifications once so the ticket_url / application_url
      // transforms below can gate against known-aggregator domains.
      // See mcp-server/src/url-classification.ts.
      const urlClassifications = await loadClassifications(db);

      // Field mapping: snake_case param → camelCase Drizzle column + optional transform
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "description", column: "description" },
        { param: "venue_id", column: "venueId" },
        { param: "promoter_id", column: "promoterId" },
        { param: "dates_confirmed", column: "datesConfirmed" },
        {
          param: "ticket_url",
          column: "ticketUrl",
          transform: (v: string) => gateUrlForField(v, "ticket", urlClassifications),
        },
        // MCP accepts dollar input; storage is integer cents (post-0044).
        { param: "ticket_price_min", column: "ticketPriceMinCents", transform: dollarsToCents },
        { param: "ticket_price_max", column: "ticketPriceMaxCents", transform: dollarsToCents },
        { param: "image_url", column: "imageUrl" },
        // IMG1 §1b Phase 1 — clamp defense-in-depth (Zod also clamps).
        {
          param: "image_focal_x",
          column: "imageFocalX",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        {
          param: "image_focal_y",
          column: "imageFocalY",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        { param: "featured", column: "featured" },
        { param: "commercial_vendors_allowed", column: "commercialVendorsAllowed" },
        { param: "vendor_fee_min", column: "vendorFeeMinCents", transform: dollarsToCents },
        { param: "vendor_fee_max", column: "vendorFeeMaxCents", transform: dollarsToCents },
        { param: "vendor_fee_notes", column: "vendorFeeNotes" },
        { param: "indoor_outdoor", column: "indoorOutdoor" },
        { param: "estimated_attendance", column: "estimatedAttendance" },
        { param: "event_scale", column: "eventScale" },
        {
          param: "application_deadline",
          column: "applicationDeadline",
          transform: (v: string) => new Date(v),
        },
        {
          param: "application_url",
          column: "applicationUrl",
          transform: (v: string) => gateUrlForField(v, "application", urlClassifications),
        },
        { param: "application_instructions", column: "applicationInstructions" },
        { param: "walk_ins_allowed", column: "walkInsAllowed" },
        // TAX1 Phase 1 (2026-06-02) — audience / access taxonomy.
        // String/bool only; no transform needed. NOT a tracked
        // citation field (per A4 these are attributes, not the
        // structural dates/venue/name/numerics).
        { param: "primary_audience", column: "primaryAudience" },
        { param: "public_access", column: "publicAccess" },
        { param: "access_notes", column: "accessNotes" },
        { param: "registration_required", column: "registrationRequired" },
        { param: "source_url", column: "sourceUrl" },
        { param: "source_id", column: "sourceId" },
        { param: "source_name", column: "sourceName" },
        { param: "recurrence_rule", column: "recurrenceRule" },
        { param: "discontinuous_dates", column: "discontinuousDates" },
        { param: "sync_enabled", column: "syncEnabled" },
        // Statewide modeling — migration 0033 introduced these columns. Allows
        // events with no single venue (Maine Maple Sunday, Open Lighthouse
        // Day) to surface on /events/<state> via state_code.
        { param: "is_statewide", column: "isStatewide" },
        {
          param: "state_code",
          column: "stateCode",
          transform: (v: unknown) => (typeof v === "string" ? v.toUpperCase() : v),
        },
        {
          param: "categories",
          column: "categories",
          transform: (v: string[]) => JSON.stringify(v),
        },
        {
          param: "tags",
          column: "tags",
          transform: (v: string[]) => JSON.stringify(v),
        },
        {
          // A3 (Dev backlog 2026-06-05): route through normalizeEventDate so
          // a bare YYYY-MM-DD lands at noon UTC (canonical anchor), not the
          // midnight-UTC `new Date()` default that ships as previous-day-EDT.
          param: "start_date",
          column: "startDate",
          transform: (v: string) => normalizeEventDate(v) ?? undefined,
        },
        {
          param: "end_date",
          column: "endDate",
          transform: (v: string) => normalizeEventDate(v) ?? undefined,
        },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          const transformed = transform ? transform(value) : value;
          if (transformed !== undefined) {
            updates[column] = transformed;
            requestedFields.push(param);
          }
        }
      }

      // Handle name separately (triggers slug regeneration unless slug is
      // explicitly provided below)
      if (params.name !== undefined) {
        updates.name = params.name;
        requestedFields.push("name");
      }
      // Track explicit slug as a requested field so previousValues / audit
      // logging captures it (the actual slug write happens in the slug-resolve
      // block below, which mirrors update_vendor).
      if (params.slug !== undefined) {
        requestedFields.push("slug");
      }

      // Collect inline venue fields
      const venueFieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "venue_name", column: "name" },
        { param: "venue_address", column: "address" },
        { param: "venue_city", column: "city" },
        { param: "venue_state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "venue_zip", column: "zip" },
      ];
      const venueUpdates: Record<string, unknown> = {};
      const venueRequestedFields: string[] = [];
      for (const { param, column, transform } of venueFieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          venueUpdates[column] = transform ? transform(value) : value;
          venueRequestedFields.push(param);
        }
      }

      if (requestedFields.length === 0 && venueRequestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Validate date ordering if both are being set
      if (updates.startDate && updates.endDate) {
        if ((updates.startDate as Date) > (updates.endDate as Date)) {
          return {
            content: [{ type: "text", text: "start_date must be before or equal to end_date." }],
            isError: true,
          };
        }
      }

      // Validate state_code shape when explicitly set. The length(2) Zod
      // check catches malformed input; this catches "12" / "ZZ" etc. that
      // pass length but aren't real US state codes.
      if (typeof updates.stateCode === "string" && !/^[A-Z]{2}$/.test(updates.stateCode)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid state_code "${updates.stateCode}". Use a 2-letter US state code (e.g. "ME", "NH").`,
            },
          ],
          isError: true,
        };
      }

      // Validate venue FK exists if provided
      if (params.venue_id) {
        const venueRows = await db
          .select({ id: venues.id })
          .from(venues)
          .where(eq(venues.id, params.venue_id))
          .limit(1);
        if (venueRows.length === 0) {
          return {
            content: [{ type: "text", text: `Venue not found: ${params.venue_id}` }],
            isError: true,
          };
        }
      }

      // Validate promoter FK exists if provided
      if (params.promoter_id) {
        const promoterRows = await db
          .select({ id: promoters.id })
          .from(promoters)
          .where(eq(promoters.id, params.promoter_id))
          .limit(1);
        if (promoterRows.length === 0) {
          return {
            content: [{ type: "text", text: `Promoter not found: ${params.promoter_id}` }],
            isError: true,
          };
        }
      }

      // Fetch current event
      const eventRows = await db
        .select()
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found." }],
          isError: true,
        };
      }

      const event = eventRows[0];

      // Statewide requires a state code. If the caller flips is_statewide=true
      // without supplying state_code AND the existing row has no state_code,
      // refuse — surfacing the event on /events/<state> requires the code.
      if (
        updates.isStatewide === true &&
        updates.stateCode === undefined &&
        !(event as { stateCode?: string | null }).stateCode
      ) {
        return {
          content: [
            {
              type: "text",
              text: "state_code is required when is_statewide=true (this event has no existing state_code). Pass state_code in the same call.",
            },
          ],
          isError: true,
        };
      }

      // Resolve final slug. Tri-case mirror of update_vendor (admin.ts ~L2344):
      //   - explicit `slug` param wins; auto-regen from name is suppressed
      //   - name alone → derive from name
      //   - neither → no slug change
      // Always run through createSlug for the canonical Slug brand (PR #120
      // three-layer defense), then collision-check with the appendSlugSegment
      // suffix loop. Bail with a clear error after 20 collisions instead of
      // looping forever.
      const explicitSlug = params.slug;
      const slugSeed =
        explicitSlug !== undefined
          ? createSlug(explicitSlug)
          : params.name !== undefined
            ? createSlug(params.name)
            : null;
      if (slugSeed && slugSeed !== event.slug) {
        let finalSlug: Slug = slugSeed;
        let suffix = 0;
        while (true) {
          const candidate: Slug = suffix > 0 ? appendSlugSegment(slugSeed, suffix) : slugSeed;
          const existing = await db
            .select({ id: events.id })
            .from(events)
            .where(eq(events.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === event.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                {
                  type: "text",
                  text: "Too many slug collisions. Try a more unique slug.",
                },
              ],
              isError: true,
            };
          }
        }
        if (finalSlug !== event.slug) {
          updates.slug = finalSlug;
        }
      }

      // Always set updatedAt
      updates.updatedAt = new Date();

      // ── Venue+date duplicate detection (K2 rewire, 2026-06-04) ──────
      // Was: inline venue+date-overlap query at the same venueId only
      // (analyst 2026-05-22 P7c). Now: delegates to the shared
      // `findDuplicate` 4-stage match via the main-app's
      // /api/suggest-event/check-duplicate route. Catches the same
      // additional cases the suggest_event rewire does: exact source_url,
      // city+state+date (covers slug-divergence cohort), similar name
      // + date. Still warning-only — `acknowledge_possible_duplicates`
      // suppresses the warning, never blocks.
      let possibleDuplicatesWarning: Array<{
        id: string;
        name: string;
        slug: string;
        dates: string;
        status: string;
        match_type?: string;
      }> | null = null;
      const mergedVenueId =
        params.venue_id !== undefined
          ? params.venue_id
          : ((event as { venueId?: string | null }).venueId ?? null);
      if (
        params.venue_id !== undefined &&
        params.start_date !== undefined &&
        mergedVenueId &&
        updates.startDate instanceof Date &&
        !params.acknowledge_possible_duplicates
      ) {
        // K2 rewire: look up the venue row so we can pass venueName +
        // venueCity + venueState into findDuplicate. The helper needs
        // these for the venue_date + city_state_date stages — without
        // them it would fall back to source_url-only matching.
        const newStartDate = updates.startDate as Date;
        const [venueRow] = await db
          .select({
            name: venues.name,
            city: venues.city,
            state: venues.state,
          })
          .from(venues)
          .where(eq(venues.id, mergedVenueId))
          .limit(1);

        const dupe = await checkDuplicateViaMainApp(env ?? {}, {
          sourceUrl: (params.source_url as string | undefined) ?? null,
          name: params.name ?? null,
          startDate: newStartDate.toISOString().slice(0, 10),
          venueName: venueRow?.name ?? null,
          venueCity: venueRow?.city ?? null,
          venueState: venueRow?.state ?? null,
        });

        // Self-filter: findDuplicate doesn't know the calling event's
        // id. If the match IS the event we're updating, suppress the
        // warning — matching yourself isn't a duplicate.
        if (dupe.isDuplicate && dupe.existingEvent.id !== event.id) {
          possibleDuplicatesWarning = [
            {
              id: dupe.existingEvent.id,
              name: dupe.existingEvent.name,
              slug: dupe.existingEvent.slug,
              dates: formatDateRange(dupe.existingEvent.startDate, null),
              status: dupe.existingEvent.status,
              match_type: dupe.matchType,
            },
          ];
        }
      }

      // ── Pre-ingest gate re-evaluation (analyst 2026-05-22 P2) ──────
      // Before this hook, gates fired only on INSERT — an update_event call
      // that introduced a "Call for Vendors" name, a start_date ==
      // application_deadline collision, etc. would silently skip the same
      // gates the suggest_event ingest path runs. Now: if any gate-relevant
      // field changes, evaluate against the post-merge view, persist any
      // firing reasons into events.gate_flags, and surface the warning in
      // the response. Independent of the P7c venue+date dedup above — both
      // can fire on the same call and surface side-by-side under warnings.
      //
      // This tool does NOT change status (see tool description), so unlike
      // the main-app PATCH there's no APPROVED → PENDING downgrade to make
      // here. Admins reviewing flagged rows still use update_event_status
      // for the transition.
      const gateRelevantChanging =
        params.name !== undefined ||
        params.description !== undefined ||
        params.start_date !== undefined ||
        params.end_date !== undefined ||
        params.application_deadline !== undefined ||
        params.event_scale !== undefined ||
        params.source_url !== undefined ||
        params.source_name !== undefined ||
        params.discontinuous_dates !== undefined;

      let gateFlagsWarning: string[] | null = null;
      if (gateRelevantChanging) {
        const evRow = event as Record<string, unknown>;
        const mergedStartDate =
          updates.startDate !== undefined
            ? (updates.startDate as Date | null)
            : ((evRow.startDate as Date | null | undefined) ?? null);
        const mergedEndDate =
          updates.endDate !== undefined
            ? (updates.endDate as Date | null)
            : ((evRow.endDate as Date | null | undefined) ?? null);
        const mergedApplicationDeadline =
          updates.applicationDeadline !== undefined
            ? (updates.applicationDeadline as Date | null)
            : ((evRow.applicationDeadline as Date | null | undefined) ?? null);
        const mergedDescription =
          params.description !== undefined
            ? params.description
            : ((evRow.description as string | null | undefined) ?? null);
        const mergedEventScale =
          params.event_scale !== undefined
            ? params.event_scale
            : ((evRow.eventScale as string | null | undefined) ?? null);
        const mergedSourceUrl =
          params.source_url !== undefined
            ? params.source_url
            : ((evRow.sourceUrl as string | null | undefined) ?? null);
        const mergedSourceName =
          params.source_name !== undefined
            ? params.source_name
            : ((evRow.sourceName as string | null | undefined) ?? null);
        // Recurring-series signals for duration-too-long-for-scale exemption
        // (analyst 2026-05-26): biweekly markets and season-spanning events
        // legitimately have long start→end spans. Either signal suffices.
        const mergedDiscontinuous =
          params.discontinuous_dates !== undefined
            ? params.discontinuous_dates
            : ((evRow.discontinuousDates as boolean | null | undefined) ?? null);
        const [{ count: eventDaysCount } = { count: 0 }] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(eventDays)
          .where(eq(eventDays.eventId, event.id));

        const gateResult = evaluateGates({
          name: params.name ?? (evRow.name as string | null | undefined) ?? null,
          sourceUrl: mergedSourceUrl,
          sourceName: mergedSourceName,
          startDate: mergedStartDate,
          endDate: mergedEndDate,
          applicationDeadline: mergedApplicationDeadline,
          description: mergedDescription,
          eventScale: mergedEventScale,
          discontinuousDates: mergedDiscontinuous,
          eventDaysCount: eventDaysCount ?? 0,
        });

        if (gateResult.route === "PENDING_REVIEW") {
          gateFlagsWarning = gateResult.reasons;
          updates.gateFlags = JSON.stringify(gateResult.reasons);
          // Make sure the gate-flags column write actually happens even if
          // no other field is in `requestedFields` — the existing write
          // block only fires when requestedFields.length > 0. Add a synthetic
          // marker so the gate-only path still writes.
          if (!requestedFields.includes("gate_flags")) {
            requestedFields.push("gate_flags");
          }
        }
      }

      // Capture previous values for confirmation
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "name") {
          previousValues.name = event.name;
          previousValues.slug = event.slug;
          continue;
        }
        if (field === "slug") {
          previousValues.slug = event.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (event as Record<string, unknown>)[mapping.column];
        }
      }

      // Execute event update (skip if only venue fields provided)
      if (requestedFields.length > 0) {
        // SYN1 — outbox row + version bump in the SAME batch as the UPDATE so a
        // correction is never dropped. Gated on a mirrored field (name/start/
        // end) changing; returns [] otherwise → falls back to a plain UPDATE.
        const syndicationStmts = await eventOutboxStatements(db, {
          eventId: event.id,
          changedFields: Object.keys(updates),
          event: {
            name: (updates.name as string) ?? event.name,
            slug: (updates.slug as string) ?? event.slug,
            startDate: updates.startDate !== undefined ? updates.startDate : event.startDate,
            endDate: updates.endDate !== undefined ? updates.endDate : event.endDate,
          },
          venueId: (updates.venueId !== undefined
            ? (updates.venueId as string | null)
            : event.venueId) as string | null,
        });
        if (syndicationStmts.length > 0) {
          await db.batch([
            db.update(events).set(updates).where(eq(events.id, event.id)),
            ...syndicationStmts,
          ] as unknown as Parameters<typeof db.batch>[0]);
          await enqueueSyndicationChange(env, { entityType: "event", entityId: event.id });
        } else {
          await db.update(events).set(updates).where(eq(events.id, event.id));
        }
        await recomputeEventCompleteness(db, event.id);
        await logEnrichment(db, {
          targetType: "event",
          targetId: event.id,
          source: "manual_admin",
          status: "success",
          actorUserId: auth.userId,
          fieldsChanged: requestedFields,
          notes: "MCP update_event",
        });

        // J2/C1 (2026-06-12) — log the field-level edit to admin_actions so the
        // admin_actions mining card (docs/j2-admin-actions-mining-card-brief.md)
        // can surface which fields the operator most often corrects after
        // auto-ingest (= where the extractor is weakest), joinable to the event's
        // source/promoter. `requestedFields` is the exact changed-field set used
        // for the citation insert below. Non-fatal: a logging failure must never
        // fail the edit itself.
        try {
          await db.insert(adminActions).values({
            action: "event.update",
            actorUserId: auth.userId,
            targetType: "event",
            targetId: event.id,
            payloadJson: JSON.stringify({ fields: requestedFields, source: "mcp" }),
            createdAt: new Date(),
          });
        } catch (err) {
          console.error(
            `[MCP/update_event] failed to write event.update admin_action for ${event.id}:`,
            err
          );
        }

        // Record slug rename in event_slug_history so the main app's
        // middleware 301-redirects the old URL. Mirrors the admin route at
        // src/app/api/admin/events/[id]/route.ts (drizzle/0061). Non-fatal
        // on insert error — the rename has already succeeded above.
        if (typeof updates.slug === "string" && updates.slug !== event.slug) {
          try {
            await db.insert(eventSlugHistory).values({
              eventId: event.id,
              oldSlug: event.slug,
              newSlug: unsafeSlug(updates.slug),
              changedAt: new Date(),
              changedBy: auth.userId,
            });
          } catch (err) {
            console.error(
              `[MCP/update_event] failed to write event_slug_history row for ${event.id} (${event.slug} → ${updates.slug}):`,
              err
            );
          }
        }
      }

      // Citation insert: for each tracked field touched, record a citation
      // row keyed to the supplied source. Mirrors create_event_citation but
      // skips the denormalized column write (already happened above). Runs
      // after the event update so a citation row never exists without the
      // corresponding column write.
      const citationsInserted: Array<{
        citation_id: string;
        field_name: string;
        superseded_count: number;
      }> = [];
      if (params.citation && requestedFields.length > 0) {
        const citationYear = params.citation.year ?? null;
        for (const field of requestedFields) {
          const denorm = CITATION_DENORM_FIELD_MAP[field];
          if (!denorm) continue;
          const rawValue = (params as Record<string, unknown>)[field];
          if (rawValue === undefined || rawValue === null) continue;
          const valueText = String(rawValue);

          // Supersede prior active for (event, field, year). Match NULL year
          // explicitly because SQL `=` treats NULL as unequal.
          let supersededId: string | null = null;
          let supersededCount = 0;
          const yearFilter =
            citationYear === null
              ? sql`${eventDataCitations.year} IS NULL`
              : eq(eventDataCitations.year, citationYear);
          const prior = await db
            .select({ id: eventDataCitations.id })
            .from(eventDataCitations)
            .where(
              and(
                eq(eventDataCitations.eventId, event.id),
                eq(eventDataCitations.fieldName, field),
                yearFilter,
                eq(eventDataCitations.state, "active")
              )
            );
          if (prior.length > 0) {
            supersededId = prior[0].id;
            const ids = prior.map((r) => r.id);
            await db
              .update(eventDataCitations)
              .set({ state: "superseded", updatedAt: new Date() })
              .where(inArray(eventDataCitations.id, ids));
            supersededCount = ids.length;
          }

          const citationId = crypto.randomUUID();
          await db.insert(eventDataCitations).values({
            id: citationId,
            eventId: event.id,
            fieldName: field,
            value: valueText,
            year: citationYear,
            sourceUrl: params.citation.source_url,
            sourceName: params.citation.source_name ?? null,
            sourceType: params.citation.source_type,
            confidence: params.citation.confidence ?? null,
            state: "active",
            notes: params.citation.notes ?? null,
            supersedesCitationId: supersededId,
            createdBy: auth.userId ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          citationsInserted.push({
            citation_id: citationId,
            field_name: field,
            superseded_count: supersededCount,
          });
        }
      }

      // IndexNow: ping if a material field changed on an already-public event.
      // "Material" = fields rendered on the public detail page that affect SERP
      // snippets — name, description, dates, venue. Other admin-y fields
      // (featured, source_id, etc.) don't merit a re-index ping.
      // is_statewide / state_code re-trigger because they reclassify the event
      // onto /events/<state>; the URL itself doesn't change but the listing
      // pages do (per feedback_enum_widening_audit.md re: classification flips
      // silently bypassing IndexNow).
      if (env && PUBLIC_EVENT_SET.has(event.status)) {
        const materialFields = [
          "name",
          "description",
          "start_date",
          "end_date",
          "venue_id",
          "is_statewide",
          "state_code",
        ];
        if (requestedFields.some((f) => materialFields.includes(f))) {
          const finalSlug = (updates.slug as string | undefined) ?? event.slug;
          await triggerIndexNow(publicUrlFor("events", finalSlug), env, "event-update", {
            defer: params.defer_search_ping ?? false,
            db,
            entity: { type: "event", id: event.id, slug: finalSlug, action: "update" },
          });
        }
      }

      // Build new values for confirmation
      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      // Handle inline venue field updates
      let venueUpdateResult: Record<string, unknown> | null = null;
      if (venueRequestedFields.length > 0) {
        // Determine which venue to update
        const targetVenueId = params.venue_id ?? event.venueId;
        if (!targetVenueId) {
          return {
            content: [
              {
                type: "text",
                text: "Event has no linked venue. Use create_venue + venue_id to link one first.",
              },
            ],
            isError: true,
          };
        }

        // Fetch current venue for previous values
        const venueRows = await db
          .select()
          .from(venues)
          .where(eq(venues.id, targetVenueId))
          .limit(1);

        if (venueRows.length === 0) {
          return {
            content: [{ type: "text", text: `Linked venue not found: ${targetVenueId}` }],
            isError: true,
          };
        }

        const venue = venueRows[0];
        const venuePreviousValues: Record<string, unknown> = {};
        const venueNewValues: Record<string, unknown> = {};

        for (const field of venueRequestedFields) {
          const mapping = venueFieldMap.find((f) => f.param === field);
          if (mapping) {
            venuePreviousValues[field] = (venue as Record<string, unknown>)[mapping.column];
            venueNewValues[field] = (params as Record<string, unknown>)[field];
          }
        }

        // If venue_name changed, regenerate slug
        if (venueUpdates.name !== undefined) {
          const baseSlug = createSlug(venueUpdates.name as string);
          let finalSlug = baseSlug;
          let suffix = 0;
          while (true) {
            const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
            const existing = await db
              .select({ id: venues.id })
              .from(venues)
              .where(eq(venues.slug, candidate))
              .limit(1);
            if (existing.length === 0 || existing[0].id === venue.id) {
              finalSlug = candidate;
              break;
            }
            suffix++;
            if (suffix > 20) break;
          }
          venueUpdates.slug = finalSlug;
          venuePreviousValues.slug = venue.slug;
          venueNewValues.slug = finalSlug;
        }

        venueUpdates.updatedAt = new Date();
        await db.update(venues).set(venueUpdates).where(eq(venues.id, venue.id));

        venueUpdateResult = {
          venue_id: venue.id,
          venue_name: venue.name,
          fieldsUpdated: venueRequestedFields,
          previousValues: venuePreviousValues,
          newValues: venueNewValues,
        };
      }

      const result: Record<string, unknown> = {
        updated: true,
        event: { id: event.id, name: updates.name ?? event.name },
      };
      if (requestedFields.length > 0) {
        result.fieldsUpdated = requestedFields;
        result.previousValues = previousValues;
        result.newValues = newValues;
      }
      if (venueUpdateResult) {
        result.venueUpdated = venueUpdateResult;
      }
      if (citationsInserted.length > 0) {
        result.citationsInserted = citationsInserted;
      }
      // Warnings: both P7c venue+date duplicates and P2 gate-flag re-eval
      // can fire on the same call. Surface both under `warnings`; admins
      // can act on either independently. The update has already succeeded
      // by this point — warnings never block.
      const warnings: Record<string, unknown> = {};
      if (possibleDuplicatesWarning && possibleDuplicatesWarning.length > 0) {
        warnings.possible_duplicates = possibleDuplicatesWarning;
        warnings.message = `Found ${possibleDuplicatesWarning.length} existing event(s) at the same venue with overlapping dates. Review and re-call with acknowledge_possible_duplicates=true if these are distinct events.`;
      }
      if (gateFlagsWarning) {
        warnings.gate_flags = gateFlagsWarning;
      }
      if (Object.keys(warnings).length > 0) {
        result.warnings = warnings;
      }

      return { content: [jsonContent(result)] };
    }
  );

  // ── upload_event_image ─────────────────────────────────────────
  // Bulk image enrichment: fetch a publicly-accessible image URL, forward
  // to the main app's R2-backed upload endpoint, and persist the resulting
  // CDN URL on the event. Mirrors the (admin-only) vendor logo upload route
  // but goes through the X-Internal-Key auth path because MCP doesn't have
  // an admin session cookie.
  //
  // Workflow target: the recommendations panel currently flags ~89% of
  // events as missing imagery. Until this tool existed, every image had to
  // be hosted externally first (Imgur, organizer site, Facebook, etc.) —
  // the analyst's 2026-05-06 memo flagged that as the bottleneck. Now an
  // organizer's image URL goes straight to cdn.meetmeatthefair.com.
  server.tool(
    "upload_event_image",
    "Fetch an image from a public URL and store it on cdn.meetmeatthefair.com, then set the event's image_url. Returns the new CDN URL. Max 5MB; allowed types: jpg, png, webp, svg. Use this instead of update_event(image_url=...) when the source image isn't on a stable host (e.g. Facebook, organizer sites that change paths). Admin only.",
    {
      event_id: z.string().describe("Event ID (UUID) to attach the image to."),
      image_url: z
        .string()
        .url()
        .describe(
          "Publicly fetchable URL of the source image. The MCP server fetches this URL, validates the content type and size, then uploads the bytes to R2."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "upload_event_image requires MAIN_APP_URL and INTERNAL_API_KEY to be configured on the MCP Worker.",
            },
          ],
          isError: true,
        };
      }

      // Verify the event exists upfront — saves a round trip + an R2 put if
      // the caller mistyped the ID.
      const [eventRow] = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (!eventRow) {
        return {
          content: [{ type: "text", text: `Event not found: ${params.event_id}` }],
          isError: true,
        };
      }

      // Fetch the source image. Cap timeout at 15s — Workers have a 30s
      // budget total; 15s for the fetch + headroom for the multipart POST
      // to the main app + the main app's R2 put fits comfortably.
      let imageResponse: Response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        imageResponse = await fetch(params.image_url, {
          // Some CDN hosts (Facebook, image-proxy services) reject the
          // default User-Agent; setting a plausible one materially improves
          // hit rate without any additional auth.
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MMATFBot/1.0)" },
          signal: controller.signal,
        });
        clearTimeout(timeout);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch source image: ${err instanceof Error ? err.message : "unknown error"}`,
            },
          ],
          isError: true,
        };
      }
      if (!imageResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Source image fetch returned HTTP ${imageResponse.status} — verify the URL is publicly accessible.`,
            },
          ],
          isError: true,
        };
      }

      const contentType = imageResponse.headers.get("Content-Type") ?? "application/octet-stream";
      const bytes = await imageResponse.arrayBuffer();
      // Mirror the main-app endpoint's 5MB cap so we surface a clearer error
      // here rather than letting the multipart POST fail with HTTP 400.
      if (bytes.byteLength > 5 * 1024 * 1024) {
        return {
          content: [
            {
              type: "text",
              text: `Source image is ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB — max 5 MB. Resize or pick a smaller variant.`,
            },
          ],
          isError: true,
        };
      }

      // Forward as multipart to the main app endpoint. The main app's
      // /api/admin/events/[id]/upload-image handler validates content type,
      // puts to R2, updates events.image_url, and returns the CDN URL.
      const filename = (() => {
        // Pick a sensible filename for the CDN customMetadata.originalName
        // field. Helps when debugging "where did this image come from".
        try {
          const u = new URL(params.image_url);
          const last = u.pathname.split("/").filter(Boolean).pop() ?? "image";
          return last.length > 100 ? "source-image" : last;
        } catch {
          return "source-image";
        }
      })();
      const blob = new Blob([bytes], { type: contentType });
      const formData = new FormData();
      formData.append("file", blob, filename);

      let uploadResponse: Response;
      try {
        uploadResponse = await fetch(
          `${env.MAIN_APP_URL}/api/admin/events/${params.event_id}/upload-image`,
          {
            method: "POST",
            headers: {
              "X-Internal-Key": env.INTERNAL_API_KEY,
              // No Content-Type header — fetch sets it (with boundary) when
              // body is FormData.
            },
            body: formData,
          }
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Upload to main app failed: ${err instanceof Error ? err.message : "unknown error"}`,
            },
          ],
          isError: true,
        };
      }

      const uploadResult = (await uploadResponse.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!uploadResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Upload failed (${uploadResponse.status}): ${
                typeof uploadResult.error === "string" ? uploadResult.error : "unknown"
              }`,
            },
          ],
          isError: true,
        };
      }

      // Recompute completeness on the MCP side too — the main app already
      // did this, but the MCP enrichment log is the source of truth for the
      // /admin/analytics enrichment page.
      await logEnrichment(db, {
        targetType: "event",
        targetId: params.event_id,
        source: "manual_admin",
        status: "success",
        fieldsChanged: ["image_url"],
        actorUserId: auth.userId,
        notes: `MCP upload_event_image from ${params.image_url}`,
      });

      return {
        content: [
          jsonContent({
            event_id: params.event_id,
            url: uploadResult.url,
            key: uploadResult.key,
            source_url: params.image_url,
            bytes: bytes.byteLength,
          }),
        ],
      };
    }
  );

  // ── list_event_vendors_admin ───────────────────────────────────
  server.tool(
    "list_event_vendors_admin",
    "List all vendors for any event with full status details. Admin only. K18 Phase 1: each row returns its `event_day_id` + resolved date; series-wide links have `event_day_id: null`. Optional `event_day_id` filter narrows to one occurrence.",
    {
      event_id: z.string().describe("Event ID"),
      status: z.enum(VENDOR_STATUS_ENUM).optional().describe("Filter by vendor application status"),
      // K18 Phase 1 — optional per-occurrence filter. Default behavior
      // returns ALL links (series-wide + per-day); operator UI groups by
      // date itself.
      event_day_id: z
        .string()
        .optional()
        .describe(
          "K18 Phase 1: filter to links scoped to this specific occurrence. Omit for all links (series-wide + per-day)."
        ),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip for pagination (default 0)"),
    },
    async (params) => {
      // Verify event exists
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: "Event not found." }],
          isError: true,
        };
      }

      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const conditions = [eq(eventVendors.eventId, eventRows[0].id)];
      if (params.status) {
        conditions.push(eq(eventVendors.status, params.status));
      }
      if (params.event_day_id) {
        conditions.push(eq(eventVendors.eventDayId, params.event_day_id));
      }

      // K18 Phase 1: LEFT JOIN event_days to surface the resolved date
      // string alongside the eventDayId. NULL eventDayId → NULL date.
      const rows = await db
        .select({
          applicationId: eventVendors.id,
          vendorId: eventVendors.vendorId,
          status: eventVendors.status,
          paymentStatus: eventVendors.paymentStatus,
          boothInfo: eventVendors.boothInfo,
          createdAt: eventVendors.createdAt,
          businessName: vendors.businessName,
          // EH2.1 — surface display_name override on the admin lineup so
          // admins see the brand surface (e.g. "LeafFilter") consistently
          // with what users see on the public event page.
          vendorDisplayName: vendors.displayName,
          vendorSlug: vendors.slug,
          vendorType: vendors.vendorType,
          products: vendors.products,
          commercial: vendors.commercial,
          eventDayId: eventVendors.eventDayId,
          eventDayDate: eventDays.date,
        })
        .from(eventVendors)
        .innerJoin(vendors, eq(eventVendors.vendorId, vendors.id))
        .leftJoin(eventDays, eq(eventVendors.eventDayId, eventDays.id))
        .where(and(...conditions))
        .orderBy(sql`${vendors.businessName} COLLATE NOCASE`)
        .limit(limit)
        .offset(offset);

      const output = rows.map((r) => ({
        applicationId: r.applicationId,
        status: r.status,
        paymentStatus: r.paymentStatus,
        boothInfo: r.boothInfo,
        appliedAt: r.createdAt?.toISOString() || null,
        event_day_id: r.eventDayId,
        event_day_date: r.eventDayDate, // YYYY-MM-DD or null for series-wide
        vendor: {
          id: r.vendorId,
          businessName: r.businessName,
          // EH2.1 — computed surface name (display_name override applied;
          // full brand-parent gate resolution is on get_vendor_details).
          display_name: r.vendorDisplayName ?? r.businessName,
          slug: r.vendorSlug,
          type: r.vendorType,
          products: parseJsonArray(r.products),
          commercial: r.commercial,
        },
      }));

      return {
        content: [
          jsonContent({
            event: eventRows[0].name,
            count: output.length,
            offset,
            has_more: output.length === limit,
            vendors: output,
          }),
        ],
      };
    }
  );

  // ── create_vendor ──────────────────────────────────────────────
  server.tool(
    "create_vendor",
    "Create a new vendor profile on the platform. Returns the vendor ID for use with update_vendor_status to link to events. Admin only.",
    {
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
        .describe("Vendor category (e.g. 'Home Improvement', 'Food', 'Crafts')"),
      description: z
        .string()
        .max(500)
        .transform(sanitizeProse)
        .optional()
        .describe("Business description"),
      products: z
        .array(z.string().transform(sanitizeProse))
        .optional()
        .describe("List of products/services offered"),
      location: z.string().optional().describe("City and state, e.g. 'Portland, ME'"),
      website: z.string().optional().describe("Vendor website URL"),
      contact_email: z.string().optional().describe("Primary contact email address"),
      contact_phone: z.string().optional().describe("Contact phone number"),
      logo_url: z.string().optional().describe("URL to vendor logo image"),
      // IMG1 §1b Phase 1 — per-image focal point. Applies to logo_url.
      // Most logos are square so default (0.5, 0.5) center works; this
      // exists for non-square logo rescues. Same Zod validation as the
      // admin-UI FocalPointPicker.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Horizontal focal point for logo crops, 0–1. Default 0.5."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Vertical focal point for logo crops, 0–1. Default 0.5."),
      // EH1 Phase 1 — optional hierarchy + relationship fields at create
      // time. Most callers leave these unset (the row defaults to
      // role='INDEPENDENT', relationship_type='independent'). Useful when
      // an ingestion path knows up-front that a row is an office of an
      // existing brand. The three audited admin tools remain the
      // preferred path for relationship edits after creation.
      role: z
        .enum(["NATIONAL", "LOCAL_OFFICE", "INDEPENDENT"])
        .optional()
        .describe("Hierarchy role at create time. Defaults to INDEPENDENT."),
      brand_parent_vendor_id: z
        .string()
        .optional()
        .describe("Brand-parent vendor id (the consumer-facing brand)."),
      operator_parent_vendor_id: z
        .string()
        .optional()
        .describe("Operator-parent vendor id (contracts/billing entity)."),
      relationship_type: z
        .enum([
          "branch",
          "franchise",
          "dealer",
          "member",
          "agent",
          "employee_branch",
          "government",
          "independent",
        ])
        .optional()
        .describe("8-shape relationship typology. Defaults to 'independent'."),
      default_child_display: z
        .enum(["self", "brand_parent", "both"])
        .optional()
        .describe("For NATIONAL rows: the default display target for child offices."),
      display_override_permitted: z
        .boolean()
        .optional()
        .describe("For LOCAL_OFFICE rows: the per-office gate. Defaults to false."),
      display_mode: z
        .enum(["inherit", "self", "brand_parent", "operator_parent", "both"])
        .optional()
        .describe("For LOCAL_OFFICE rows: the office's own display preference."),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, queue the IndexNow ping for batched flush via flush_pending_search_pings. Bulk-ingestion workflows should set this true."
        ),
    },
    async (params) => {
      // Check for duplicate business name (exact match, case-insensitive via LIKE)
      const existing = await db
        .select({ id: vendors.id, slug: vendors.slug })
        .from(vendors)
        .where(eq(vendors.businessName, params.business_name))
        .limit(1);

      if (existing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A vendor with the name "${params.business_name}" already exists (slug: ${existing[0].slug}). Use search_vendors to find it.`,
            },
          ],
          isError: true,
        };
      }

      // Generate unique slug
      const baseSlug = createSlug(params.business_name);
      if (!baseSlug) {
        return {
          content: [
            { type: "text", text: "Could not generate a valid slug from the business name." },
          ],
          isError: true,
        };
      }

      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
        const slugCheck = await db
          .select({ id: vendors.id })
          .from(vendors)
          .where(eq(vendors.slug, candidate))
          .limit(1);
        if (slugCheck.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
        if (suffix > 20) {
          return {
            content: [
              { type: "text", text: "Too many slug collisions. Try a more unique business name." },
            ],
            isError: true,
          };
        }
      }

      // Create placeholder user (vendor table requires userId FK)
      const placeholderEmail = `pending+${finalSlug}@meetmeatthefair.com`;
      const userId = crypto.randomUUID();

      await db.insert(users).values({
        id: userId,
        email: placeholderEmail,
        role: "VENDOR",
      });

      // Parse location into city/state
      const loc = params.location ? parseLocation(params.location) : { city: null, state: null };

      // Create vendor record
      const vendorId = crypto.randomUUID();

      await db.insert(vendors).values({
        id: vendorId,
        userId,
        businessName: params.business_name,
        slug: finalSlug,
        vendorType: params.type ?? null,
        description: params.description ?? null,
        products: params.products ? JSON.stringify(params.products) : "[]",
        website: params.website ?? null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
        logoUrl: params.logo_url ?? null,
        // IMG1 §1b Phase 1 — focal point (clamped); omit when undefined
        // so the column DEFAULT (0.5) applies.
        ...(params.image_focal_x !== undefined && {
          imageFocalX: Math.max(0, Math.min(1, params.image_focal_x)),
        }),
        ...(params.image_focal_y !== undefined && {
          imageFocalY: Math.max(0, Math.min(1, params.image_focal_y)),
        }),
        city: loc.city,
        state: loc.state,
        // EH1 Phase 1 — hierarchy + relationship fields. Drizzle column
        // defaults handle the absent-key case (role='INDEPENDENT',
        // relationship_type='independent', display_override_permitted=0).
        ...(params.role !== undefined && { role: params.role }),
        ...(params.brand_parent_vendor_id !== undefined && {
          brandParentVendorId: params.brand_parent_vendor_id,
        }),
        ...(params.operator_parent_vendor_id !== undefined && {
          operatorParentVendorId: params.operator_parent_vendor_id,
        }),
        ...(params.relationship_type !== undefined && {
          relationshipType: params.relationship_type,
        }),
        ...(params.default_child_display !== undefined && {
          defaultChildDisplay: params.default_child_display,
        }),
        ...(params.display_override_permitted !== undefined && {
          displayOverridePermitted: params.display_override_permitted,
        }),
        ...(params.display_mode !== undefined && { displayMode: params.display_mode }),
      });

      await recomputeVendorCompleteness(db, vendorId);

      await logEnrichment(db, {
        targetType: "vendor",
        targetId: vendorId,
        source: "mcp_create",
        status: "success",
        actorUserId: auth.userId,
        notes: "MCP create_vendor",
      });

      // IndexNow: vendors have no status field — they're public on creation.
      if (env) {
        await triggerIndexNow(publicUrlFor("vendors", finalSlug), env, "vendor-create", {
          defer: params.defer_search_ping ?? false,
          db,
          entity: { type: "vendor", id: vendorId, slug: finalSlug, action: "create" },
        });
      }

      return {
        content: [
          jsonContent({
            created: true,
            vendor_id: vendorId,
            slug: finalSlug,
            business_name: params.business_name,
          }),
        ],
      };
    }
  );

  // ── update_vendor_status ───────────────────────────────────────
  server.tool(
    "update_vendor_status",
    "Change a vendor's application status, payment status, or participation_type on an event. If no vendor-event link exists, creates one (upsert). Admin only.",
    {
      event_id: z.string().describe("Event ID"),
      vendor_id: z.string().describe("Vendor ID"),
      status: z.enum(VENDOR_STATUS_ENUM).optional().describe("New vendor application status"),
      payment_status: z.enum(PAYMENT_STATUS_ENUM).optional().describe("New payment status"),
      participation_type: z
        .enum(PARTICIPATION_TYPE_ENUM)
        .optional()
        .describe(
          "New participation mode. EXHIBITOR / SPONSOR_ONLY / SPONSOR_AND_EXHIBITOR. Public event page splits the vendor list by this field."
        ),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, queue the IndexNow ping for batched flush via flush_pending_search_pings."
        ),
    },
    async (params) => {
      if (!params.status && !params.payment_status && !params.participation_type) {
        return {
          content: [
            {
              type: "text",
              text: "Provide at least one of status, payment_status, or participation_type to update.",
            },
          ],
          isError: true,
        };
      }

      // Pre-fetch event slug so we can fire IndexNow after a transition into
      // the public vendor set (the public event page changes when the vendor
      // list grows).
      const eventSlugRows = await db
        .select({ slug: events.slug })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      const eventSlug = eventSlugRows[0]?.slug;

      // Find the event-vendor record
      const rows = await db
        .select({
          id: eventVendors.id,
          status: eventVendors.status,
          paymentStatus: eventVendors.paymentStatus,
          participationType: eventVendors.participationType,
        })
        .from(eventVendors)
        .where(
          and(
            eq(eventVendors.eventId, params.event_id),
            eq(eventVendors.vendorId, params.vendor_id)
          )
        )
        .limit(1);

      // ── UPSERT: create vendor-event link if none exists ──
      if (rows.length === 0) {
        // Verify event exists
        const eventCheck = await db
          .select({ id: events.id, name: events.name })
          .from(events)
          .where(eq(events.id, params.event_id))
          .limit(1);
        if (eventCheck.length === 0) {
          return { content: [{ type: "text", text: "Event not found." }], isError: true };
        }

        // Verify vendor exists
        const vendorCheck = await db
          .select({ id: vendors.id, businessName: vendors.businessName })
          .from(vendors)
          .where(eq(vendors.id, params.vendor_id))
          .limit(1);
        if (vendorCheck.length === 0) {
          return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
        }

        const newStatus = params.status ?? "INVITED";
        const newPaymentStatus = params.payment_status ?? "NOT_REQUIRED";
        const newParticipationType = params.participation_type ?? "EXHIBITOR";

        await db.insert(eventVendors).values({
          eventId: params.event_id,
          vendorId: params.vendor_id,
          status: newStatus,
          paymentStatus: newPaymentStatus,
          participationType: newParticipationType,
        });

        // Audit — UPSERT path (new event_vendors link)
        await db.insert(adminActions).values({
          action: "event_vendor.create",
          actorUserId: auth.userId,
          targetType: "event_vendor",
          targetId: `${params.event_id}:${params.vendor_id}`,
          payloadJson: JSON.stringify({
            event_id: params.event_id,
            vendor_id: params.vendor_id,
            status: newStatus,
            payment_status: newPaymentStatus,
          }),
          createdAt: new Date(),
        });

        if (env && PUBLIC_VENDOR_SET.has(newStatus) && eventSlug) {
          await triggerIndexNow(publicUrlFor("events", eventSlug), env, "event-vendor-link", {
            defer: params.defer_search_ping ?? false,
            db,
            entity: { type: "event", id: params.event_id, slug: eventSlug, action: "update" },
          });
        }

        return {
          content: [
            jsonContent({
              created: true,
              eventId: params.event_id,
              eventName: eventCheck[0].name,
              vendorId: params.vendor_id,
              vendorName: vendorCheck[0].businessName,
              status: newStatus,
              paymentStatus: newPaymentStatus,
            }),
          ],
        };
      }

      // ── UPDATE existing record ──
      const record = rows[0];
      const updates: Record<string, unknown> = {};
      const result: Record<string, unknown> = {
        updated: true,
        eventId: params.event_id,
        vendorId: params.vendor_id,
      };

      // Validate status transition
      if (params.status) {
        const allowed = VALID_TRANSITIONS[record.status];
        if (!allowed || !allowed.includes(params.status)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid transition: ${record.status} → ${params.status}. Allowed transitions from ${record.status}: ${(allowed || []).join(", ") || "none"}.`,
              },
            ],
            isError: true,
          };
        }

        updates.status = params.status;
        result.previousStatus = record.status;
        result.newStatus = params.status;
      }

      // Payment status — no transition validation, admin can set freely
      if (params.payment_status) {
        updates.paymentStatus = params.payment_status;
        result.previousPaymentStatus = record.paymentStatus;
        result.newPaymentStatus = params.payment_status;
      }

      // Participation type — also no transition validation; admin sets freely
      // since this is a description of the relationship, not a workflow stage.
      if (params.participation_type) {
        updates.participationType = params.participation_type;
        result.previousParticipationType = record.participationType;
        result.newParticipationType = params.participation_type;
      }

      await db.update(eventVendors).set(updates).where(eq(eventVendors.id, record.id));

      // Audit — UPDATE path (status and/or payment_status change)
      await db.insert(adminActions).values({
        action: "event_vendor.status_change",
        actorUserId: auth.userId,
        targetType: "event_vendor",
        targetId: `${params.event_id}:${params.vendor_id}`,
        payloadJson: JSON.stringify({
          event_id: params.event_id,
          vendor_id: params.vendor_id,
          previous_status: result.previousStatus,
          new_status: result.newStatus,
          previous_payment_status: result.previousPaymentStatus,
          new_payment_status: result.newPaymentStatus,
        }),
        createdAt: new Date(),
      });

      if (
        env &&
        params.status &&
        PUBLIC_VENDOR_SET.has(params.status) &&
        !PUBLIC_VENDOR_SET.has(record.status) &&
        eventSlug
      ) {
        await triggerIndexNow(publicUrlFor("events", eventSlug), env, "event-vendor-link", {
          defer: params.defer_search_ping ?? false,
          db,
          entity: { type: "event", id: params.event_id, slug: eventSlug, action: "status_change" },
        });
      }

      return { content: [jsonContent(result)] };
    }
  );

  // ── rescrape_events ─────────────────────────────────────────────
  server.tool(
    "rescrape_events",
    "Re-scrape specific events from their original source URLs to refresh descriptions, dates, images, and ticket URLs. Provide event IDs to re-scrape. Max 50 per request. Admin only.",
    {
      event_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Array of event IDs to re-scrape from their source URLs"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Re-scrape is not configured. MAIN_APP_URL and INTERNAL_API_KEY must be set in the MCP server environment.",
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await fetch(`${env.MAIN_APP_URL}/api/admin/import/rescrape-events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": env.INTERNAL_API_KEY,
          },
          body: JSON.stringify({ event_ids: params.event_ids }),
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
          return {
            content: [
              {
                type: "text",
                text: `Re-scrape failed (${response.status}): ${errorData.error || response.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const result = await response.json();
        return { content: [jsonContent(result)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Re-scrape request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── update_venue ──────────────────────────────────────────────
  server.tool(
    "update_venue",
    "Update venue fields (name, address, coordinates, etc.). Admin only.",
    {
      venue_id: z.string().describe("Venue ID (UUID)"),
      name: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Venue name (also regenerates slug)"),
      address: z.string().optional().describe("Street address"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      zip: z.string().optional().describe("ZIP code"),
      latitude: z.number().optional().describe("Latitude coordinate"),
      longitude: z.number().optional().describe("Longitude coordinate"),
      description: z.string().transform(sanitizeProse).optional().describe("Venue description"),
      capacity: z.number().int().optional().describe("Venue capacity"),
      website: z.string().optional().describe("Website URL"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      image_url: z.string().optional().describe("Venue image URL"),
      // IMG1 §1b Phase 1 — per-image focal point for card crops.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Horizontal focal point for card crops, 0–1. Default 0.5."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Vertical focal point for card crops, 0–1. Default 0.5."),
      status: z.enum(["ACTIVE", "INACTIVE"]).optional().describe("Venue status"),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "address", column: "address" },
        { param: "city", column: "city" },
        { param: "state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "zip", column: "zip" },
        { param: "latitude", column: "latitude" },
        { param: "longitude", column: "longitude" },
        { param: "description", column: "description" },
        { param: "capacity", column: "capacity" },
        { param: "website", column: "website" },
        { param: "contact_email", column: "contactEmail" },
        { param: "contact_phone", column: "contactPhone" },
        { param: "image_url", column: "imageUrl" },
        // IMG1 §1b Phase 1 — clamp defense-in-depth.
        {
          param: "image_focal_x",
          column: "imageFocalX",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        {
          param: "image_focal_y",
          column: "imageFocalY",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        { param: "status", column: "status" },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          updates[column] = transform ? transform(value) : value;
          requestedFields.push(param);
        }
      }

      if (params.name !== undefined) {
        updates.name = params.name;
        requestedFields.push("name");
      }

      if (requestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Fetch current venue
      const venueRows = await db
        .select()
        .from(venues)
        .where(eq(venues.id, params.venue_id))
        .limit(1);

      if (venueRows.length === 0) {
        return { content: [{ type: "text", text: "Venue not found." }], isError: true };
      }

      const venue = venueRows[0];

      // If name changed, regenerate slug with collision check
      if (params.name !== undefined) {
        const baseSlug = createSlug(params.name);
        let finalSlug = baseSlug;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
          const existing = await db
            .select({ id: venues.id })
            .from(venues)
            .where(eq(venues.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === venue.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions. Try a more unique name." },
              ],
              isError: true,
            };
          }
        }
        updates.slug = finalSlug;
      }

      updates.updatedAt = new Date();

      // Capture previous values
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "name") {
          previousValues.name = venue.name;
          previousValues.slug = venue.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (venue as Record<string, unknown>)[mapping.column];
        }
      }

      // SYN1 — venue correction fans out to every event at the venue (outbox
      // row + a single events-version bump), committed in the same batch.
      const venueSyndicationStmts = venueOutboxStatements(db, {
        venueId: venue.id,
        changedFields: Object.keys(updates),
        venue: {
          name: (updates.name as string) ?? venue.name,
          address: (updates.address as string) ?? venue.address,
          city: (updates.city as string) ?? venue.city,
          state: (updates.state as string) ?? venue.state,
          zip: (updates.zip as string) ?? venue.zip,
        },
      });
      if (venueSyndicationStmts.length > 0) {
        await db.batch([
          db.update(venues).set(updates).where(eq(venues.id, venue.id)),
          ...venueSyndicationStmts,
        ] as unknown as Parameters<typeof db.batch>[0]);
        await enqueueSyndicationChange(env, { entityType: "venue", entityId: venue.id });
      } else {
        await db.update(venues).set(updates).where(eq(venues.id, venue.id));
      }

      // IndexNow: distinguish first-publish (INACTIVE→ACTIVE) from material
      // edits on already-ACTIVE venues so analytics can attribute pings.
      if (env) {
        const wasActive = venue.status === "ACTIVE";
        const newStatus = (updates.status as string | undefined) ?? venue.status;
        const isActive = newStatus === "ACTIVE";
        let venueSource: string | null = null;
        if (!wasActive && isActive) {
          venueSource = "venue-activate";
        } else if (wasActive && isActive) {
          const materialFields = ["name", "address", "city", "state", "description"];
          if (requestedFields.some((f) => materialFields.includes(f))) {
            venueSource = "venue-update";
          }
        }
        if (venueSource) {
          const finalSlug = (updates.slug as string | undefined) ?? venue.slug;
          await triggerIndexNow(publicUrlFor("venues", finalSlug), env, venueSource, {
            defer: params.defer_search_ping ?? false,
            db,
            entity: {
              type: "venue",
              id: venue.id,
              slug: finalSlug,
              action: venueSource === "venue-activate" ? "status_change" : "update",
            },
          });
        }
      }

      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      return {
        content: [
          jsonContent({
            updated: true,
            venue: { id: venue.id, name: updates.name ?? venue.name },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    }
  );

  // ── create_venue ──────────────────────────────────────────────
  server.tool(
    "create_venue",
    "Create a new venue record. Returns the venue ID for use with update_event. Admin only.",
    {
      name: z.string().min(1).max(200).transform(sanitizeProse).describe("Venue name"),
      address: z.string().min(1).describe("Street address"),
      city: z.string().min(1).describe("City"),
      state: z.string().min(1).max(2).describe("State (2-letter code)"),
      zip: z.string().min(1).describe("ZIP code"),
      latitude: z.number().optional().describe("Latitude coordinate"),
      longitude: z.number().optional().describe("Longitude coordinate"),
      capacity: z.number().int().optional().describe("Venue capacity"),
      website: z.string().optional().describe("Website URL"),
      description: z.string().transform(sanitizeProse).optional().describe("Venue description"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      image_url: z.string().optional().describe("Venue image URL"),
      // IMG1 §1b Phase 1 — per-image focal point. Applies to image_url.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Horizontal focal point for card crops, 0–1. Default 0.5."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Vertical focal point for card crops, 0–1. Default 0.5."),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      // DQ2 (2026-06-04): coerce address-as-name BEFORE dedup. When
      // `params.name` is a bare street address or equals `params.address`,
      // derive a real name from city/state and shift the offending
      // string into address (if address was empty). Running this BEFORE
      // the dedup check ensures dedup sees the coerced name, so we
      // don't accidentally create another "Event venue in {City}, {State}"
      // duplicate alongside an existing one.
      const coerced = coerceVenueNameAtIngest({
        name: params.name,
        address: params.address,
        city: params.city,
        state: params.state,
      });
      const effectiveName = coerced.name;
      const effectiveAddress = coerced.address;

      // Warn on potential duplicate (same name + city + state)
      const dupeCheck = await db
        .select({ id: venues.id, slug: venues.slug })
        .from(venues)
        .where(
          and(
            eq(venues.name, effectiveName),
            eq(venues.city, params.city),
            sql`upper(${venues.state}) = upper(${params.state})`
          )
        )
        .limit(1);

      if (dupeCheck.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A venue named "${effectiveName}" already exists in ${params.city}, ${params.state} (slug: ${dupeCheck[0].slug}, id: ${dupeCheck[0].id}). Use update_venue to modify it, or choose a different name.`,
            },
          ],
          isError: true,
        };
      }

      // Generate unique slug
      const baseSlug = createSlug(effectiveName);
      if (!baseSlug) {
        return {
          content: [{ type: "text", text: "Could not generate a valid slug from the venue name." }],
          isError: true,
        };
      }

      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
        const slugCheck = await db
          .select({ id: venues.id })
          .from(venues)
          .where(eq(venues.slug, candidate))
          .limit(1);
        if (slugCheck.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
        if (suffix > 20) {
          return {
            content: [{ type: "text", text: "Too many slug collisions. Try a more unique name." }],
            isError: true,
          };
        }
      }

      const venueId = crypto.randomUUID();

      await db.insert(venues).values({
        id: venueId,
        // DQ2-coerced values from above — never write back the raw
        // address-as-name if `coerced.wasCoerced` was true.
        name: effectiveName,
        slug: finalSlug,
        address: effectiveAddress,
        city: params.city,
        state: params.state.toUpperCase(),
        zip: params.zip,
        latitude: params.latitude ?? null,
        longitude: params.longitude ?? null,
        capacity: params.capacity ?? null,
        website: params.website ?? null,
        description: params.description ?? null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
        imageUrl: params.image_url ?? null,
        // IMG1 §1b Phase 1 — focal point (clamped); omit when undefined
        // so the column DEFAULT (0.5) applies.
        ...(params.image_focal_x !== undefined && {
          imageFocalX: Math.max(0, Math.min(1, params.image_focal_x)),
        }),
        ...(params.image_focal_y !== undefined && {
          imageFocalY: Math.max(0, Math.min(1, params.image_focal_y)),
        }),
      });

      // IndexNow: venues created via this tool default to ACTIVE (public)
      // immediately, so ping right away.
      if (env) {
        await triggerIndexNow(publicUrlFor("venues", finalSlug), env, "venue-create", {
          defer: params.defer_search_ping ?? false,
          db,
          entity: { type: "venue", id: venueId, slug: finalSlug, action: "create" },
        });
      }

      return {
        content: [
          jsonContent({
            created: true,
            venue_id: venueId,
            slug: finalSlug,
            name: params.name,
            location: `${params.city}, ${params.state.toUpperCase()}`,
          }),
        ],
      };
    }
  );

  // ── delete_venue ──────────────────────────────────────────────
  server.tool(
    "delete_venue",
    "Delete a venue. Refuses if any events reference this venue — reassign or delete those first. Admin only.",
    {
      venue_id: z.string().uuid().describe("Venue ID to delete"),
    },
    async ({ venue_id }) => {
      const venue = await db
        .select({ id: venues.id, name: venues.name, slug: venues.slug })
        .from(venues)
        .where(eq(venues.id, venue_id))
        .limit(1);

      if (venue.length === 0) {
        return {
          content: [{ type: "text", text: `Venue ${venue_id} not found.` }],
          isError: true,
        };
      }

      const attachedEvents = await db
        .select({ id: events.id, name: events.name, slug: events.slug })
        .from(events)
        .where(eq(events.venueId, venue_id))
        .limit(10);

      if (attachedEvents.length > 0) {
        return {
          content: [
            jsonContent({
              deleted: false,
              venue_id,
              reason:
                "Venue has attached events. Reassign their venue_id (or mark them is_statewide + clear venue_id) before deleting this venue.",
              attached_events: attachedEvents,
            }),
          ],
          isError: true,
        };
      }

      await db.delete(venues).where(eq(venues.id, venue_id));

      return {
        content: [
          jsonContent({
            deleted: true,
            venue_id,
            name: venue[0].name,
            slug: venue[0].slug,
          }),
        ],
      };
    }
  );

  // ── delete_vendor ─────────────────────────────────────────────
  // Soft-delete primitive with optional 301 redirect to a canonical
  // replacement. Most cleanups are duplicate-vendor consolidations where
  // we want to redirect (not destroy) inbound links — that's the default
  // mode="soft" path. mode="hard" purges immediately and is reserved for
  // the post-grace-window or force=true cases. Delegates to main app
  // (DELETE /api/admin/vendors/[id]) via INTERNAL_API_KEY (mirrors
  // delete_blog_post pattern).
  server.tool(
    "delete_vendor",
    "Soft-delete a vendor (default) with optional 301 redirect to a canonical replacement. Refuses if vendor has active event commitments, active Enhanced Profile, or active user claim — force=true overrides with required reason. mode='hard' purges immediately and requires either an existing soft-delete >30 days old OR force=true. Admin only.",
    {
      vendor_id: z.string().uuid().describe("Vendor ID to delete"),
      mode: z
        .enum(["soft", "hard"])
        .optional()
        .describe(
          "'soft' (default) flips deleted_at and 301-redirects (if redirect target set). 'hard' purges immediately."
        ),
      redirect_to_vendor_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Optional canonical-vendor ID to 301-redirect to. Most duplicate cleanups use this."
        ),
      rewrite_blog_links: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true and redirect_to_vendor_id is set, content_links rows pointing at the deleted vendor get re-pointed at the redirect target. Destructive (irreversible)."
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, overrides the three refuse conditions (active events / Enhanced Profile / claim). Requires reason."
        ),
      reason: z
        .string()
        .min(10)
        .max(500)
        .optional()
        .describe(
          "Required when force=true. Free-text rationale logged to admin_actions for audit review."
        ),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "delete_vendor requires MAIN_APP_URL and INTERNAL_API_KEY to be configured.",
            },
          ],
          isError: true,
        };
      }
      try {
        const { vendor_id, ...body } = params;
        const response = await fetch(
          `${env.MAIN_APP_URL}/api/admin/vendors/${encodeURIComponent(vendor_id)}`,
          {
            method: "DELETE",
            headers: {
              "X-Internal-Key": env.INTERNAL_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }
        );
        const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            content: [jsonContent({ ...responseBody, http_status: response.status })],
            isError: true,
          };
        }
        return { content: [jsonContent(responseBody)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `delete_vendor failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── undelete_vendor ───────────────────────────────────────────
  server.tool(
    "undelete_vendor",
    "Undo a soft-delete. Clears deleted_at; vendor reappears in sitemap, listings, event vendor lists. Does NOT clear redirect_to_vendor_id (admin can clear separately by passing redirect_to_vendor_id: null via update_vendor, or leave it for the case where you intentionally want both the original and the redirect-target to coexist). IndexNow ping fires so search engines re-discover. Admin only.",
    {
      vendor_id: z.string().uuid().describe("Vendor ID to undelete"),
    },
    async (params) => {
      if (!env?.MAIN_APP_URL || !env?.INTERNAL_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "undelete_vendor requires MAIN_APP_URL and INTERNAL_API_KEY to be configured.",
            },
          ],
          isError: true,
        };
      }
      try {
        const response = await fetch(
          `${env.MAIN_APP_URL}/api/admin/vendors/${encodeURIComponent(params.vendor_id)}/undelete`,
          {
            method: "POST",
            headers: {
              "X-Internal-Key": env.INTERNAL_API_KEY,
              "Content-Type": "application/json",
            },
          }
        );
        const responseBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            content: [jsonContent({ ...responseBody, http_status: response.status })],
            isError: true,
          };
        }
        return { content: [jsonContent(responseBody)] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `undelete_vendor failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── update_vendor ─────────────────────────────────────────────
  server.tool(
    "update_vendor",
    "Update any vendor's profile fields. Admin only.",
    {
      vendor_id: z.string().describe("Vendor ID (UUID)"),
      business_name: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Business name (also regenerates slug)"),
      vendor_type: z.string().transform(sanitizeProse).optional().describe("Vendor category"),
      description: z.string().transform(sanitizeProse).optional().describe("Business description"),
      products: z
        .array(z.string().transform(sanitizeProse))
        .optional()
        .describe("Products/services list"),
      website: z.string().optional().describe("Website URL"),
      contact_name: z.string().optional().describe("Contact person name"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      address: z.string().optional().describe("Street address"),
      zip: z.string().optional().describe("ZIP code"),
      logo_url: z.string().optional().describe("Logo image URL"),
      // IMG1 §1b Phase 1 — per-image focal point. Applies to logo_url.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Horizontal focal point for logo crops, 0–1. Default 0.5."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Vertical focal point for logo crops, 0–1. Default 0.5."),
      social_links: z.string().optional().describe("Social media links (JSON string)"),
      verified: z.boolean().optional().describe("Verified status"),
      commercial: z.boolean().optional().describe("Commercial vendor flag"),
      can_self_confirm: z
        .boolean()
        .optional()
        .describe("Whether vendor can auto-confirm applications"),
      // Enhanced Profile (round-3) — most callers use set_enhanced_profile for
      // activation; these params are escape hatches for one-off adjustments.
      enhanced_profile: z
        .boolean()
        .optional()
        .describe("Enhanced Profile flag (paid tier). Prefer set_enhanced_profile for activation."),
      enhanced_profile_expires_at: z
        .string()
        .optional()
        .describe("Enhanced Profile expiry as ISO 8601 string"),
      gallery_images: z
        .array(
          z.object({
            url: z.string(),
            alt: z.string().transform(sanitizeProse),
            caption: z.string().transform(sanitizeProse).optional(),
          })
        )
        .max(2)
        .optional()
        .describe("Gallery images (max 2). Each: {url, alt, caption?}"),
      slug: z
        .string()
        .optional()
        .describe(
          "Custom slug. Setting this writes a vendor_slug_history row for 301-redirect from old slug."
        ),
      featured_priority: z
        .number()
        .int()
        .optional()
        .describe("Featured rotation pin override; 0 = participate in shuffle, >0 = pinned high."),
      // EH1 Phase 1 (drizzle/0106 + 0107) — hierarchy + relationship fields.
      // Patch-only semantics: omitted params don't blank existing values.
      // Prefer the three audited admin tools (set_vendor_relationship,
      // set_vendor_display_policy, set_vendor_alias) when their richer
      // validation + audit log matters; this surface is the escape hatch
      // for one-off adjustments.
      role: z
        .enum(["NATIONAL", "LOCAL_OFFICE", "INDEPENDENT"])
        .optional()
        .describe("Hierarchy role: NATIONAL parent brand, LOCAL_OFFICE child, or INDEPENDENT."),
      brand_parent_vendor_id: z
        .string()
        .nullable()
        .optional()
        .describe("Brand-parent vendor id (the consumer-facing brand). Null clears."),
      operator_parent_vendor_id: z
        .string()
        .nullable()
        .optional()
        .describe("Operator-parent vendor id (contracts/billing entity). Null clears."),
      alias_of_vendor_id: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Mark this row as an alias of the given canonical vendor id. Null clears. Prefer set_vendor_alias to also repoint events."
        ),
      relationship_type: z
        .enum([
          "branch",
          "franchise",
          "dealer",
          "member",
          "agent",
          "employee_branch",
          "government",
          "independent",
        ])
        .optional()
        .describe("8-shape relationship typology. Defaults to 'independent'."),
      default_child_display: z
        .enum(["self", "brand_parent", "both"])
        .nullable()
        .optional()
        .describe(
          "Brand-parent's default for its offices' display target. Only meaningful on NATIONAL rows."
        ),
      display_override_permitted: z
        .boolean()
        .optional()
        .describe("Parent-controlled gate — only meaningful on LOCAL_OFFICE rows."),
      display_mode: z
        .enum(["inherit", "self", "brand_parent", "operator_parent", "both"])
        .nullable()
        .optional()
        .describe(
          "Office's display preference. Only honored when display_override_permitted=true and mode != 'inherit'."
        ),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "vendor_type", column: "vendorType" },
        { param: "description", column: "description" },
        { param: "products", column: "products", transform: (v: string[]) => JSON.stringify(v) },
        { param: "website", column: "website" },
        { param: "contact_name", column: "contactName" },
        { param: "contact_email", column: "contactEmail" },
        { param: "contact_phone", column: "contactPhone" },
        { param: "city", column: "city" },
        { param: "state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "address", column: "address" },
        { param: "zip", column: "zip" },
        { param: "logo_url", column: "logoUrl" },
        // IMG1 §1b Phase 1 — clamp defense-in-depth.
        {
          param: "image_focal_x",
          column: "imageFocalX",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        {
          param: "image_focal_y",
          column: "imageFocalY",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        { param: "social_links", column: "socialLinks" },
        { param: "verified", column: "verified" },
        { param: "commercial", column: "commercial" },
        { param: "can_self_confirm", column: "canSelfConfirm" },
        { param: "enhanced_profile", column: "enhancedProfile" },
        {
          param: "enhanced_profile_expires_at",
          column: "enhancedProfileExpiresAt",
          transform: (v: string) => new Date(v),
        },
        {
          param: "gallery_images",
          column: "galleryImages",
          transform: (v: unknown) => JSON.stringify(v),
        },
        { param: "featured_priority", column: "featuredPriority" },
        // EH1 Phase 1 — hierarchy + relationship fields.
        { param: "role", column: "role" },
        { param: "brand_parent_vendor_id", column: "brandParentVendorId" },
        { param: "operator_parent_vendor_id", column: "operatorParentVendorId" },
        { param: "alias_of_vendor_id", column: "aliasOfVendorId" },
        { param: "relationship_type", column: "relationshipType" },
        { param: "default_child_display", column: "defaultChildDisplay" },
        { param: "display_override_permitted", column: "displayOverridePermitted" },
        { param: "display_mode", column: "displayMode" },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          updates[column] = transform ? transform(value) : value;
          requestedFields.push(param);
        }
      }

      if (params.business_name !== undefined) {
        updates.businessName = params.business_name;
        requestedFields.push("business_name");
      }

      if (params.slug !== undefined) {
        requestedFields.push("slug");
      }

      if (requestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Fetch current vendor
      const vendorRows = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);

      if (vendorRows.length === 0) {
        return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
      }

      const vendor = vendorRows[0];

      // If a custom slug was explicitly provided, it takes priority over the
      // auto-generated slug from business_name. Both paths run through the
      // collision check + write a vendor_slug_history row when the slug
      // actually changes.
      const explicitSlug = params.slug;
      const slugSeed =
        explicitSlug !== undefined
          ? createSlug(explicitSlug)
          : params.business_name !== undefined
            ? createSlug(params.business_name)
            : null;

      if (slugSeed && slugSeed !== vendor.slug) {
        let finalSlug = slugSeed;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? appendSlugSegment(slugSeed, suffix) : slugSeed;
          const existing = await db
            .select({ id: vendors.id })
            .from(vendors)
            .where(eq(vendors.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === vendor.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions. Try a more unique name." },
              ],
              isError: true,
            };
          }
        }
        if (finalSlug !== vendor.slug) {
          updates.slug = finalSlug;
        }
      }

      updates.updatedAt = new Date();

      // Capture previous values
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "business_name") {
          previousValues.business_name = vendor.businessName;
          previousValues.slug = vendor.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (vendor as Record<string, unknown>)[mapping.column];
        }
      }

      await db.update(vendors).set(updates).where(eq(vendors.id, vendor.id));

      await recomputeVendorCompleteness(db, vendor.id);

      await logEnrichment(db, {
        targetType: "vendor",
        targetId: vendor.id,
        source: "manual_admin",
        status: "success",
        actorUserId: auth.userId,
        fieldsChanged: Object.keys(updates).filter((k) => k !== "updatedAt"),
        notes: "MCP update_vendor",
      });

      // Slug change: record the old→new mapping for 301 redirects on /vendors/[slug].
      if (updates.slug && updates.slug !== vendor.slug) {
        await db.insert(vendorSlugHistory).values({
          vendorId: vendor.id,
          oldSlug: vendor.slug,
          newSlug: unsafeSlug(updates.slug as string),
          changedAt: new Date(),
          changedBy: auth.userId,
        });
      }

      // IndexNow: ping when fields rendered on the public vendor page change.
      // The material list now includes Enhanced Profile fields (round-3) since
      // those changes affect what gets rendered on the public profile (gallery,
      // verified badge, contact form vs raw email).
      if (env) {
        const materialFields = [
          "business_name",
          "vendor_type",
          "description",
          "products",
          "city",
          "state",
          "enhanced_profile",
          "gallery_images",
          "slug",
        ];
        if (requestedFields.some((f) => materialFields.includes(f))) {
          const finalSlug = (updates.slug as string | undefined) ?? vendor.slug;
          await triggerIndexNow(publicUrlFor("vendors", finalSlug), env, "vendor-update", {
            defer: params.defer_search_ping ?? false,
            db,
            entity: { type: "vendor", id: vendor.id, slug: finalSlug, action: "update" },
          });
        }
      }

      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.business_name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      return {
        content: [
          jsonContent({
            updated: true,
            vendor: { id: vendor.id, businessName: updates.businessName ?? vendor.businessName },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    }
  );

  // ── set_enhanced_profile ──────────────────────────────────────
  // One-shot activate / deactivate for the Enhanced Profile paid tier.
  // Activation: flag=1, verified=1, started_at (only if not already set),
  //   expires_at = now + duration_days, optional custom_slug change.
  // Deactivation: sets expires_at=now to start the 30-day grace; the daily
  //   sweep endpoint flips the flag. Does NOT immediately remove enhanced
  //   features — that's the spec's intent so customers don't lose their
  //   site presence the moment a payment lapses.
  server.tool(
    "set_enhanced_profile",
    "Activate or deactivate Enhanced Profile (paid tier) for a vendor. Activation sets enhanced_profile=1, verified=1, expires_at = now + duration_days. Deactivation sets expires_at=now to start the 30-day grace period (the daily sweep endpoint flips the flag). Optionally sets a custom slug, which writes a vendor_slug_history row. Admin only.",
    {
      vendor_id: z.string().describe("Vendor ID (UUID)"),
      active: z
        .boolean()
        .describe("true = activate, false = start grace period (no immediate flag flip)"),
      duration_days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Activation duration in days. Default 365."),
      custom_slug: z
        .string()
        .optional()
        .describe("Optional custom slug (e.g. branded URL). Triggers vendor_slug_history row."),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      const vendorRows = await db
        .select()
        .from(vendors)
        .where(eq(vendors.id, params.vendor_id))
        .limit(1);

      if (vendorRows.length === 0) {
        return { content: [{ type: "text", text: "Vendor not found." }], isError: true };
      }
      const vendor = vendorRows[0];
      const now = new Date();
      const updates: Record<string, unknown> = { updatedAt: now };

      if (params.active) {
        const durationDays = params.duration_days ?? 365;
        updates.enhancedProfile = true;
        updates.verified = true;
        updates.enhancedProfileExpiresAt = new Date(now.getTime() + durationDays * 86400000);
        // Preserve started_at across off→on cycles: only stamp on initial activation.
        if (!vendor.enhancedProfileStartedAt) {
          updates.enhancedProfileStartedAt = now;
        }
      } else {
        // Soft-deactivate: start the grace period.
        updates.enhancedProfileExpiresAt = now;
      }

      // Custom slug handling — same shape as update_vendor's slug logic.
      let slugChanged: { from: Slug; to: Slug } | null = null;
      if (params.custom_slug && params.custom_slug !== vendor.slug) {
        const slugSeed = createSlug(params.custom_slug);
        let finalSlug = slugSeed;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? appendSlugSegment(slugSeed, suffix) : slugSeed;
          const existing = await db
            .select({ id: vendors.id })
            .from(vendors)
            .where(eq(vendors.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === vendor.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions on the requested custom slug." },
              ],
              isError: true,
            };
          }
        }
        if (finalSlug !== vendor.slug) {
          updates.slug = finalSlug;
          slugChanged = { from: vendor.slug, to: finalSlug };
        }
      }

      await db.update(vendors).set(updates).where(eq(vendors.id, vendor.id));

      await recomputeVendorCompleteness(db, vendor.id);

      await logEnrichment(db, {
        targetType: "vendor",
        targetId: vendor.id,
        source: "manual_admin",
        status: "success",
        actorUserId: auth.userId,
        fieldsChanged: Object.keys(updates).filter((k) => k !== "updatedAt"),
        notes: "MCP update_vendor_status",
      });

      if (slugChanged) {
        await db.insert(vendorSlugHistory).values({
          vendorId: vendor.id,
          oldSlug: slugChanged.from,
          newSlug: slugChanged.to,
          changedAt: now,
          changedBy: auth.userId,
        });
      }

      // Audit log row — captures the lifecycle transition for later analysis.
      await db.insert(adminActions).values({
        action: params.active ? "enhanced_profile.activate" : "enhanced_profile.expire_set",
        actorUserId: auth.userId,
        targetType: "vendor",
        targetId: vendor.id,
        payloadJson: JSON.stringify({
          duration_days: params.duration_days,
          slug_changed: slugChanged,
          previous_expires_at: vendor.enhancedProfileExpiresAt,
        }),
        createdAt: now,
      });

      // IndexNow: this is a material change either way (profile content
      // visibility flips or expires_at shifts), so always ping.
      if (env) {
        const finalSlug = (updates.slug as string | undefined) ?? vendor.slug;
        await triggerIndexNow(publicUrlFor("vendors", finalSlug), env, "vendor-update", {
          defer: params.defer_search_ping ?? false,
          db,
          entity: { type: "vendor", id: vendor.id, slug: finalSlug, action: "status_change" },
        });
      }

      return {
        content: [
          jsonContent({
            updated: true,
            vendor: { id: vendor.id, businessName: vendor.businessName },
            active: params.active,
            enhancedProfile: updates.enhancedProfile ?? vendor.enhancedProfile,
            expiresAt: (updates.enhancedProfileExpiresAt as Date).toISOString(),
            slugChanged,
          }),
        ],
      };
    }
  );

  // ── create_promoter ────────────────────────────────────────────
  server.tool(
    "create_promoter",
    "Create a new promoter (event organizer) on the platform. Returns the promoter ID for use with update_event to link events. Admin only.",
    {
      name: z
        .string()
        .min(1)
        .max(200)
        .transform(sanitizeProse)
        .describe("Company/organization name"),
      website: z.string().optional().describe("Promoter website URL"),
      description: z
        .string()
        .max(500)
        .transform(sanitizeProse)
        .optional()
        .describe("Promoter description"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      contact_email: z.string().optional().describe("Primary contact email address"),
      contact_phone: z.string().optional().describe("Contact phone number"),
      logo_url: z.string().optional().describe("URL to promoter logo image"),
      // IMG1 §1b Phase 1 — per-image focal point. Applies to logo_url.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Horizontal focal point for logo crops, 0–1. Default 0.5."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Vertical focal point for logo crops, 0–1. Default 0.5."),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      // Check for duplicate company name (exact match)
      const existing = await db
        .select({ id: promoters.id, slug: promoters.slug })
        .from(promoters)
        .where(eq(promoters.companyName, params.name))
        .limit(1);

      if (existing.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `A promoter with the name "${params.name}" already exists (slug: ${existing[0].slug}). Use search_promoters to find it.`,
            },
          ],
          isError: true,
        };
      }

      // Generate unique slug
      const baseSlug = createSlug(params.name);
      if (!baseSlug) {
        return {
          content: [{ type: "text", text: "Could not generate a valid slug from the name." }],
          isError: true,
        };
      }

      let finalSlug = baseSlug;
      let suffix = 0;
      while (true) {
        const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
        const slugCheck = await db
          .select({ id: promoters.id })
          .from(promoters)
          .where(eq(promoters.slug, candidate))
          .limit(1);
        if (slugCheck.length === 0) {
          finalSlug = candidate;
          break;
        }
        suffix++;
        if (suffix > 20) {
          return {
            content: [{ type: "text", text: "Too many slug collisions. Try a more unique name." }],
            isError: true,
          };
        }
      }

      // Create placeholder user (promoters table has userId FK)
      const placeholderEmail = `pending+promoter-${finalSlug}@meetmeatthefair.com`;
      const userId = crypto.randomUUID();

      await db.insert(users).values({
        id: userId,
        email: placeholderEmail,
        role: "PROMOTER",
      });

      // Create promoter record
      const promoterId = crypto.randomUUID();

      await db.insert(promoters).values({
        id: promoterId,
        userId,
        companyName: params.name,
        slug: finalSlug,
        description: params.description ?? null,
        website: params.website ?? null,
        logoUrl: params.logo_url ?? null,
        // IMG1 §1b Phase 1 — focal point (clamped); omit when undefined
        // so the column DEFAULT (0.5) applies.
        ...(params.image_focal_x !== undefined && {
          imageFocalX: Math.max(0, Math.min(1, params.image_focal_x)),
        }),
        ...(params.image_focal_y !== undefined && {
          imageFocalY: Math.max(0, Math.min(1, params.image_focal_y)),
        }),
        city: params.city ?? null,
        state: params.state ? params.state.toUpperCase() : null,
        contactEmail: params.contact_email ?? null,
        contactPhone: params.contact_phone ?? null,
      });

      // IndexNow: ping the new public promoter URL. Round 6 (PR #66) shipped
      // /promoters/[slug] as a real public surface, so this no longer pings a
      // 404. Mirrors the main-app POST /api/admin/promoters hook.
      if (env) {
        await triggerIndexNow(publicUrlFor("promoters", finalSlug), env, "promoter-create", {
          defer: params.defer_search_ping ?? false,
          db,
          entity: { type: "promoter", id: promoterId, slug: finalSlug, action: "create" },
        });
      }

      return {
        content: [
          jsonContent({
            created: true,
            promoter_id: promoterId,
            slug: finalSlug,
            name: params.name,
          }),
        ],
      };
    }
  );

  // ── update_promoter ───────────────────────────────────────────
  server.tool(
    "update_promoter",
    "Update any promoter's profile fields. Admin only.",
    {
      promoter_id: z.string().describe("Promoter ID (UUID)"),
      name: z
        .string()
        .transform(sanitizeProse)
        .optional()
        .describe("Company name (also regenerates slug)"),
      description: z.string().transform(sanitizeProse).optional().describe("Promoter description"),
      website: z.string().optional().describe("Website URL"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State (2-letter code)"),
      contact_email: z.string().optional().describe("Contact email"),
      contact_phone: z.string().optional().describe("Contact phone"),
      logo_url: z.string().optional().describe("Logo image URL"),
      // IMG1 §1b Phase 1 — per-image focal point. Applies to logo_url.
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Horizontal focal point for logo crops, 0–1. Default 0.5."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Vertical focal point for logo crops, 0–1. Default 0.5."),
      social_links: z.string().optional().describe("Social media links (JSON string)"),
      verified: z.boolean().optional().describe("Verified status"),
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, queue the IndexNow ping for batched flush."),
    },
    async (params) => {
      const fieldMap: Array<{
        param: string;
        column: string;
        transform?: (v: any) => unknown;
      }> = [
        { param: "description", column: "description" },
        { param: "website", column: "website" },
        { param: "city", column: "city" },
        { param: "state", column: "state", transform: (v: string) => v.toUpperCase() },
        { param: "contact_email", column: "contactEmail" },
        { param: "contact_phone", column: "contactPhone" },
        { param: "logo_url", column: "logoUrl" },
        // IMG1 §1b Phase 1 — clamp defense-in-depth.
        {
          param: "image_focal_x",
          column: "imageFocalX",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        {
          param: "image_focal_y",
          column: "imageFocalY",
          transform: (v: number) => Math.max(0, Math.min(1, v)),
        },
        { param: "social_links", column: "socialLinks" },
        { param: "verified", column: "verified" },
      ];

      const updates: Record<string, unknown> = {};
      const requestedFields: string[] = [];

      for (const { param, column, transform } of fieldMap) {
        const value = (params as Record<string, unknown>)[param];
        if (value !== undefined) {
          updates[column] = transform ? transform(value) : value;
          requestedFields.push(param);
        }
      }

      if (params.name !== undefined) {
        updates.companyName = params.name;
        requestedFields.push("name");
      }

      if (requestedFields.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No fields provided to update. Supply at least one optional field.",
            },
          ],
          isError: true,
        };
      }

      // Fetch current promoter
      const promoterRows = await db
        .select()
        .from(promoters)
        .where(eq(promoters.id, params.promoter_id))
        .limit(1);

      if (promoterRows.length === 0) {
        return { content: [{ type: "text", text: "Promoter not found." }], isError: true };
      }

      const promoter = promoterRows[0];

      // If name changed, regenerate slug
      if (params.name !== undefined) {
        const baseSlug = createSlug(params.name);
        let finalSlug = baseSlug;
        let suffix = 0;
        while (true) {
          const candidate = suffix > 0 ? appendSlugSegment(baseSlug, suffix) : baseSlug;
          const existing = await db
            .select({ id: promoters.id })
            .from(promoters)
            .where(eq(promoters.slug, candidate))
            .limit(1);
          if (existing.length === 0 || existing[0].id === promoter.id) {
            finalSlug = candidate;
            break;
          }
          suffix++;
          if (suffix > 20) {
            return {
              content: [
                { type: "text", text: "Too many slug collisions. Try a more unique name." },
              ],
              isError: true,
            };
          }
        }
        updates.slug = finalSlug;
      }

      updates.updatedAt = new Date();

      // Capture previous values
      const previousValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        if (field === "name") {
          previousValues.name = promoter.companyName;
          previousValues.slug = promoter.slug;
          continue;
        }
        const mapping = fieldMap.find((f) => f.param === field);
        if (mapping) {
          previousValues[field] = (promoter as Record<string, unknown>)[mapping.column];
        }
      }

      await db.update(promoters).set(updates).where(eq(promoters.id, promoter.id));

      const newValues: Record<string, unknown> = {};
      for (const field of requestedFields) {
        newValues[field] = (params as Record<string, unknown>)[field];
      }
      if (params.name !== undefined && updates.slug) {
        newValues.slug = updates.slug;
      }

      // IndexNow: ping the canonical promoter URL on update. Include the
      // prior slug too if the name change generated a new slug, so engines
      // can crawl-and-redirect from the old URL. Mirrors the main-app PATCH
      // /api/admin/promoters/[id] hook.
      if (env) {
        const newSlug = (updates.slug as string | undefined) ?? promoter.slug;
        const indexNowUrls: string[] = [publicUrlFor("promoters", newSlug)];
        if (updates.slug && updates.slug !== promoter.slug) {
          indexNowUrls.push(publicUrlFor("promoters", promoter.slug));
        }
        await triggerIndexNow(indexNowUrls, env, "promoter-update", {
          defer: params.defer_search_ping ?? false,
          db,
          // Defer only enqueues the new-slug URL; the old-slug 301-redirect
          // ping is rarely meaningful in the deferred case (it's typically
          // batched alongside the new one anyway).
          entity: { type: "promoter", id: promoter.id, slug: newSlug, action: "update" },
        });
      }

      return {
        content: [
          jsonContent({
            updated: true,
            promoter: { id: promoter.id, companyName: updates.companyName ?? promoter.companyName },
            fieldsUpdated: requestedFields,
            previousValues,
            newValues,
          }),
        ],
      };
    }
  );

  // ── list_event_days ───────────────────────────────────────────
  server.tool(
    "list_event_days",
    "List the daily schedule for an event. Admin only.",
    {
      event_id: z.string().describe("Event ID"),
    },
    async (params) => {
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const days = await db
        .select({
          id: eventDays.id,
          date: eventDays.date,
          openTime: eventDays.openTime,
          closeTime: eventDays.closeTime,
          notes: eventDays.notes,
          closed: eventDays.closed,
          vendorOnly: eventDays.vendorOnly,
        })
        .from(eventDays)
        .where(eq(eventDays.eventId, params.event_id));

      return {
        content: [
          jsonContent({
            event: eventRows[0].name,
            count: days.length,
            days,
          }),
        ],
      };
    }
  );

  // ── create_event_day ──────────────────────────────────────────
  server.tool(
    "create_event_day",
    "Add a day to an event's schedule. Admin only. DQ4 (2026-06-08): open_time and close_time are now optional (NULL hours → events.flagged_for_review=1). F2 (2026-06-08): per-occurrence image_url + focal point — for series events with different art per occurrence (e.g. seasonal market posters).",
    {
      event_id: z.string().describe("Event ID"),
      date: z.string().describe("Date (YYYY-MM-DD)"),
      open_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .describe("Opening time (HH:MM). Omit for 'hours not yet confirmed'."),
      close_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .describe("Closing time (HH:MM). Omit for 'hours not yet confirmed'."),
      notes: z.string().optional().describe("Notes for this day"),
      vendor_only: z
        .boolean()
        .optional()
        .describe("Whether this is a vendor-only day (e.g., setup)"),
      // F2 — per-occurrence image. Optional; when provided, downstream
      // consumers (print sheet, DailyScheduleDisplay) can prefer this
      // over the parent event hero.
      image_url: z
        .string()
        .url()
        .optional()
        .describe("Per-occurrence image URL (F2). Overrides parent event hero for this day."),
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Per-day image focal X (0.0–1.0). Default 0.5 (center)."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Per-day image focal Y (0.0–1.0). Default 0.5 (center)."),
    },
    async (params) => {
      // Verify event exists
      const eventRows = await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);

      if (eventRows.length === 0) {
        return { content: [{ type: "text", text: "Event not found." }], isError: true };
      }

      const dayId = crypto.randomUUID();
      // DQ4: pass null through when args were omitted; drizzle/0118 made
      // the columns nullable. Flag the parent event for triage when
      // either time landed unknown.
      const openTime = params.open_time ?? null;
      const closeTime = params.close_time ?? null;
      const hoursUnknown = openTime == null || closeTime == null;

      await db.insert(eventDays).values({
        id: dayId,
        eventId: params.event_id,
        date: params.date,
        openTime,
        closeTime,
        notes: params.notes ?? null,
        vendorOnly: params.vendor_only ?? false,
        // F2: per-day image; DB defaults take over when omitted.
        ...(params.image_url !== undefined && { imageUrl: params.image_url }),
        ...(params.image_focal_x !== undefined && { imageFocalX: params.image_focal_x }),
        ...(params.image_focal_y !== undefined && { imageFocalY: params.image_focal_y }),
      });

      // Recompute public date range on parent event
      const allDays = await db
        .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
        .from(eventDays)
        .where(eq(eventDays.eventId, params.event_id));
      const { publicStartDate, publicEndDate } = computePublicDates(allDays);
      await db
        .update(events)
        .set({
          publicStartDate,
          publicEndDate,
          updatedAt: new Date(),
          ...(hoursUnknown ? { flaggedForReview: 1 } : {}),
        })
        .where(eq(events.id, params.event_id));

      return {
        content: [
          jsonContent({
            created: true,
            id: dayId,
            event: eventRows[0].name,
            date: params.date,
            openTime,
            closeTime,
            vendorOnly: params.vendor_only ?? false,
            ...(hoursUnknown ? { flaggedForReview: true } : {}),
          }),
        ],
      };
    }
  );

  // ── update_event_day ──────────────────────────────────────────
  server.tool(
    "update_event_day",
    "Update an event day's schedule. Admin only. DQ4 (2026-06-08): pass open_time=null or close_time=null to clear (renders 'Hours not yet confirmed'); a non-null value confirms hours and (if it was the last unknown row) clears the event's flagged_for_review.",
    {
      day_id: z.string().describe("Event day ID"),
      date: z.string().optional().describe("Date (YYYY-MM-DD)"),
      open_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .nullable()
        .optional()
        .describe("Opening time (HH:MM), or null to mark as 'hours not yet confirmed'."),
      close_time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .nullable()
        .optional()
        .describe("Closing time (HH:MM), or null to mark as 'hours not yet confirmed'."),
      notes: z.string().optional().describe("Notes for this day"),
      closed: z.boolean().optional().describe("Whether this day is cancelled/closed"),
      vendor_only: z
        .boolean()
        .optional()
        .describe("Whether this is a vendor-only day (e.g., setup)"),
      // F2 — per-occurrence image; null clears, undefined skips.
      image_url: z
        .string()
        .url()
        .nullable()
        .optional()
        .describe("Per-occurrence image URL (F2). null to clear."),
      image_focal_x: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Per-day image focal X (0.0–1.0)."),
      image_focal_y: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Per-day image focal Y (0.0–1.0)."),
    },
    async (params) => {
      const dayRows = await db
        .select()
        .from(eventDays)
        .where(eq(eventDays.id, params.day_id))
        .limit(1);

      if (dayRows.length === 0) {
        return { content: [{ type: "text", text: "Event day not found." }], isError: true };
      }

      const updates: Record<string, unknown> = {};
      if (params.date !== undefined) updates.date = params.date;
      // DQ4: open_time / close_time accept null (clear) AND undefined (skip).
      // Distinguish them — `?? null` on the union would erase the skip case.
      if (params.open_time !== undefined) updates.openTime = params.open_time;
      if (params.close_time !== undefined) updates.closeTime = params.close_time;
      if (params.notes !== undefined) updates.notes = params.notes;
      if (params.closed !== undefined) updates.closed = params.closed;
      if (params.vendor_only !== undefined) updates.vendorOnly = params.vendor_only;
      // F2 — per-occurrence image. Same null-vs-undefined distinction
      // as the DQ4 time args.
      if (params.image_url !== undefined) updates.imageUrl = params.image_url;
      if (params.image_focal_x !== undefined) updates.imageFocalX = params.image_focal_x;
      if (params.image_focal_y !== undefined) updates.imageFocalY = params.image_focal_y;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text", text: "No fields provided to update." }],
          isError: true,
        };
      }

      // SYN1 — a day edit that moves the parent event's PUBLIC date range
      // (date / vendor_only) fans out to subscribers. Outbox row keyed by the
      // day id; version bump + snapshot resolve to the parent event. Gated, so
      // an image/notes-only day edit stays a plain UPDATE.
      const eventId = dayRows[0].eventId;
      const [parentEvent] = await db
        .select({
          name: events.name,
          slug: events.slug,
          startDate: events.startDate,
          endDate: events.endDate,
          venueId: events.venueId,
        })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      const daySyndicationStmts = parentEvent
        ? await eventDayOutboxStatements(db, {
            dayId: params.day_id,
            eventId,
            changedFields: Object.keys(updates),
            event: parentEvent,
            venueId: parentEvent.venueId,
          })
        : [];
      if (daySyndicationStmts.length > 0) {
        await db.batch([
          db.update(eventDays).set(updates).where(eq(eventDays.id, params.day_id)),
          ...daySyndicationStmts,
        ] as unknown as Parameters<typeof db.batch>[0]);
        await enqueueSyndicationChange(env, { entityType: "event_day", entityId: params.day_id });
      } else {
        await db.update(eventDays).set(updates).where(eq(eventDays.id, params.day_id));
      }

      // Recompute public date range on parent event
      const allDays = await db
        .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
        .from(eventDays)
        .where(eq(eventDays.eventId, eventId));
      const { publicStartDate, publicEndDate } = computePublicDates(allDays);
      await db
        .update(events)
        .set({ publicStartDate, publicEndDate, updatedAt: new Date() })
        .where(eq(events.id, eventId));

      return {
        content: [
          jsonContent({
            updated: true,
            id: params.day_id,
            fieldsUpdated: Object.keys(updates),
          }),
        ],
      };
    }
  );

  // ── delete_event_day ──────────────────────────────────────────
  server.tool(
    "delete_event_day",
    "Remove a day from an event's schedule. Admin only.",
    {
      day_id: z.string().describe("Event day ID"),
    },
    async (params) => {
      const dayRows = await db
        .select({ id: eventDays.id, date: eventDays.date, eventId: eventDays.eventId })
        .from(eventDays)
        .where(eq(eventDays.id, params.day_id))
        .limit(1);

      if (dayRows.length === 0) {
        return { content: [{ type: "text", text: "Event day not found." }], isError: true };
      }

      const eventId = dayRows[0].eventId;
      await db.delete(eventDays).where(eq(eventDays.id, params.day_id));

      // Recompute public date range on parent event
      const remainingDays = await db
        .select({ date: eventDays.date, vendorOnly: eventDays.vendorOnly })
        .from(eventDays)
        .where(eq(eventDays.eventId, eventId));
      const { publicStartDate, publicEndDate } = computePublicDates(remainingDays);
      await db
        .update(events)
        .set({ publicStartDate, publicEndDate, updatedAt: new Date() })
        .where(eq(events.id, eventId));

      return {
        content: [jsonContent({ deleted: true, id: params.day_id, date: dayRows[0].date })],
      };
    }
  );
}

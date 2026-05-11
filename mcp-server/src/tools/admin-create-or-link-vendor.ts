import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, isNull, like } from "drizzle-orm";
import { adminActions, eventVendors, events, users, vendors } from "../schema.js";
import {
  PAYMENT_STATUS_ENUM,
  PUBLIC_VENDOR_STATUSES,
  VALID_TRANSITIONS,
  VENDOR_STATUS_ENUM,
  appendSlugSegment,
  createSlug,
  escapeLike,
  jsonContent,
  logEnrichment,
  parseLocation,
  publicUrlFor,
  recomputeVendorCompleteness,
  sanitizeProse,
  triggerIndexNow,
  type Slug,
} from "../helpers.js";
import { combinedSimilarity, getVendorComparisonString } from "@takemetothefair/utils";
import type { Db } from "../db.js";
import type { AuthContext } from "../auth.js";

const PUBLIC_VENDOR_SET = new Set<string>(PUBLIC_VENDOR_STATUSES);

interface Env {
  MAIN_APP?: { fetch: typeof fetch };
  MAIN_APP_URL?: string;
  INTERNAL_API_KEY?: string;
}

const DEDUP_STRATEGY_VALUES = ["strict", "fuzzy", "skip"] as const;
const FUZZY_THRESHOLD = 0.92;
const FUZZY_CANDIDATE_CAP = 200;
const REDIRECT_CHAIN_MAX_DEPTH = 5;

type VendorRow = {
  id: string;
  businessName: string;
  vendorType: string | null;
  redirectToVendorId: string | null;
  slug: Slug;
};

/**
 * Resolve a vendor row through any redirect_to_vendor_id chain. Returns the
 * canonical row (one with redirectToVendorId === null) or throws on cycle
 * detection beyond the max depth.
 */
async function resolveRedirectChain(db: Db, startRow: VendorRow): Promise<VendorRow> {
  let current = startRow;
  const visited = new Set<string>([current.id]);
  for (let depth = 0; depth < REDIRECT_CHAIN_MAX_DEPTH; depth++) {
    if (!current.redirectToVendorId) return current;
    if (visited.has(current.redirectToVendorId)) {
      throw new Error(`alias_cycle_detected: vendor ${current.id} → ${current.redirectToVendorId}`);
    }
    visited.add(current.redirectToVendorId);
    const next = await db
      .select({
        id: vendors.id,
        businessName: vendors.businessName,
        vendorType: vendors.vendorType,
        redirectToVendorId: vendors.redirectToVendorId,
        slug: vendors.slug,
      })
      .from(vendors)
      .where(eq(vendors.id, current.redirectToVendorId))
      .limit(1);
    if (next.length === 0) {
      // Dangling pointer — treat as canonical (no further follow possible).
      return current;
    }
    current = next[0];
  }
  throw new Error(
    `alias_cycle_detected: redirect chain exceeded max depth ${REDIRECT_CHAIN_MAX_DEPTH}`
  );
}

/**
 * Fuzzy candidate scan. Narrows the search via a LIKE prefix on the first
 * normalized token, then ranks the remaining set with combinedSimilarity.
 * Caps the in-memory set at FUZZY_CANDIDATE_CAP to bound CPU on large tables.
 */
async function findFuzzyMatch(
  db: Db,
  businessName: string,
  vendorType: string | null | undefined
): Promise<{ row: VendorRow; score: number } | null> {
  // Pre-narrow via LIKE on a stem of the input. This is heuristic — if the
  // candidate-side has a different first word (e.g. "The X" vs "X"), the LIKE
  // misses it. Acceptable for the speedup; admins can always pass
  // dedup_strategy: "strict" or re-run search separately.
  const stem = businessName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3)[0];

  const filters = [isNull(vendors.deletedAt)];
  if (stem) {
    filters.push(like(vendors.businessName, `%${escapeLike(stem)}%`));
  }

  const candidates = await db
    .select({
      id: vendors.id,
      businessName: vendors.businessName,
      vendorType: vendors.vendorType,
      redirectToVendorId: vendors.redirectToVendorId,
      slug: vendors.slug,
    })
    .from(vendors)
    .where(and(...filters))
    .limit(FUZZY_CANDIDATE_CAP);

  if (candidates.length === 0) return null;

  const target = getVendorComparisonString({ businessName, vendorType: vendorType ?? null });
  let best: { row: VendorRow; score: number } | null = null;

  for (const candidate of candidates) {
    const candidateStr = getVendorComparisonString({
      businessName: candidate.businessName,
      vendorType: candidate.vendorType,
    });
    const score = combinedSimilarity(target, candidateStr, 0.6, FUZZY_THRESHOLD);
    if (score < FUZZY_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = { row: candidate, score };
      continue;
    }
    if (score === best.score) {
      // Tie-break 1: exact prefix match on businessName.
      const candidateExact = candidate.businessName.toLowerCase() === businessName.toLowerCase();
      const bestExact = best.row.businessName.toLowerCase() === businessName.toLowerCase();
      if (candidateExact && !bestExact) {
        best = { row: candidate, score };
        continue;
      }
      // Tie-break 2: lower id.
      if (candidate.id < best.row.id) {
        best = { row: candidate, score };
      }
    }
  }

  return best;
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
      defer_search_ping: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, queue IndexNow ping for later flush via flush_pending_search_pings. No-op until that tool ships in PR 2."
        ),
    },
    async (params) => {
      // Runtime defaults + sanitization. Zod handles these at the boundary in
      // production, but the test harness invokes handlers directly and bypasses
      // the schema — so we mirror update_vendor_status's pattern of belt-and-
      // suspenders defaulting here. sanitizeProse is idempotent so re-applying
      // is safe even when Zod already ran.
      const businessName = sanitizeProse(params.business_name);
      const vendorType = params.type != null ? sanitizeProse(params.type) : null;
      const description = params.description != null ? sanitizeProse(params.description) : null;
      const productsClean = Array.isArray(params.products)
        ? params.products.map((p: string) => sanitizeProse(p))
        : null;
      const status = (params.status ?? "CONFIRMED") as (typeof VENDOR_STATUS_ENUM)[number];
      const paymentStatus = (params.payment_status ??
        "NOT_REQUIRED") as (typeof PAYMENT_STATUS_ENUM)[number];
      const dedupStrategy =
        (params.dedup_strategy as (typeof DEDUP_STRATEGY_VALUES)[number] | undefined) ?? "fuzzy";
      const deferSearchPing = params.defer_search_ping ?? false;

      if (businessName.length === 0) {
        return {
          content: [{ type: "text", text: "business_name is empty after sanitization." }],
          isError: true,
        };
      }

      // 1. Event resolve
      const eventRows = await db
        .select({ id: events.id, slug: events.slug, name: events.name })
        .from(events)
        .where(eq(events.id, params.event_id))
        .limit(1);
      if (eventRows.length === 0) {
        return {
          content: [{ type: "text", text: `Event not found: ${params.event_id}` }],
          isError: true,
        };
      }
      const event = eventRows[0];

      // 2. Dedup
      let matched: { row: VendorRow; score: number | null } | null = null;
      if (dedupStrategy !== "skip") {
        if (dedupStrategy === "strict") {
          // Case-insensitive exact match. SQLite default collation is binary,
          // so LOWER(TRIM(...)) on both sides is needed.
          const strictRows = await db
            .select({
              id: vendors.id,
              businessName: vendors.businessName,
              vendorType: vendors.vendorType,
              redirectToVendorId: vendors.redirectToVendorId,
              slug: vendors.slug,
            })
            .from(vendors)
            .where(and(eq(vendors.businessName, businessName), isNull(vendors.deletedAt)))
            .limit(1);
          if (strictRows.length > 0) {
            matched = { row: strictRows[0], score: 1 };
          }
        } else {
          // fuzzy
          const found = await findFuzzyMatch(db, businessName, vendorType);
          if (found) matched = { row: found.row, score: found.score };
        }

        // Redirect chain resolution.
        if (matched) {
          try {
            const canonical = await resolveRedirectChain(db, matched.row);
            matched = { row: canonical, score: matched.score };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: msg }],
              isError: true,
            };
          }
        }
      }

      let vendorId: string;
      let vendorSlug: Slug;
      let was_created = false;
      const matchedExisting = matched
        ? { name: matched.row.businessName, similarity_score: matched.score }
        : null;

      // 3. Create new vendor if no match
      if (matched) {
        vendorId = matched.row.id;
        vendorSlug = matched.row.slug;
      } else {
        const baseSlug = createSlug(businessName);
        if (!baseSlug) {
          return {
            content: [
              { type: "text", text: "Could not generate a valid slug from the business name." },
            ],
            isError: true,
          };
        }

        let finalSlug: Slug = baseSlug;
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
                {
                  type: "text",
                  text: "Too many slug collisions. Try a more unique business name.",
                },
              ],
              isError: true,
            };
          }
        }

        const placeholderEmail = `pending+${finalSlug}@meetmeatthefair.com`;
        const userId = crypto.randomUUID();
        await db.insert(users).values({
          id: userId,
          email: placeholderEmail,
          role: "VENDOR",
        });

        const loc = params.location ? parseLocation(params.location) : { city: null, state: null };

        vendorId = crypto.randomUUID();
        await db.insert(vendors).values({
          id: vendorId,
          userId,
          businessName,
          slug: finalSlug,
          vendorType,
          description,
          products: productsClean ? JSON.stringify(productsClean) : "[]",
          website: params.website ?? null,
          contactEmail: params.contact_email ?? null,
          contactPhone: params.contact_phone ?? null,
          logoUrl: params.logo_url ?? null,
          city: loc.city,
          state: loc.state,
        });

        await recomputeVendorCompleteness(db, vendorId);
        await logEnrichment(db, {
          targetType: "vendor",
          targetId: vendorId,
          source: "mcp_create",
          status: "success",
          actorUserId: auth.userId,
          notes: "MCP create_or_link_vendor (new vendor)",
        });

        vendorSlug = finalSlug;
        was_created = true;
      }

      // 4. UPSERT event_vendors
      const linkRows = await db
        .select({
          id: eventVendors.id,
          status: eventVendors.status,
          paymentStatus: eventVendors.paymentStatus,
        })
        .from(eventVendors)
        .where(and(eq(eventVendors.eventId, params.event_id), eq(eventVendors.vendorId, vendorId)))
        .limit(1);

      let was_linked = false;
      let was_already_linked = false;
      let status_changed = false;
      let eventVendorRowId: string;

      if (linkRows.length === 0) {
        eventVendorRowId = crypto.randomUUID();
        await db.insert(eventVendors).values({
          id: eventVendorRowId,
          eventId: params.event_id,
          vendorId,
          status,
          paymentStatus,
          boothInfo: params.booth_info ?? null,
        });
        was_linked = true;
      } else {
        const existing = linkRows[0];
        eventVendorRowId = existing.id;
        was_already_linked = true;

        const updates: Record<string, unknown> = {};

        if (status !== existing.status) {
          const allowed = VALID_TRANSITIONS[existing.status];
          if (!allowed || !allowed.includes(status)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid transition: ${existing.status} → ${status}. Allowed from ${existing.status}: ${(allowed || []).join(", ") || "none"}.`,
                },
              ],
              isError: true,
            };
          }
          updates.status = status;
          status_changed = true;
        }
        // Only update payment_status when explicitly provided AND different,
        // so a no-op call (same status, payment_status omitted) doesn't
        // generate a phantom UPDATE with a defaulted value.
        if (
          params.payment_status !== undefined &&
          params.payment_status !== existing.paymentStatus
        ) {
          updates.paymentStatus = params.payment_status;
        }
        if (params.booth_info !== undefined) {
          updates.boothInfo = params.booth_info;
        }

        if (Object.keys(updates).length > 0) {
          await db.update(eventVendors).set(updates).where(eq(eventVendors.id, existing.id));
        }
      }

      // 5. Lifecycle hooks. When defer_search_ping is true the helper queues
      //    rows in pending_search_pings instead of firing IndexNow inline;
      //    flush_pending_search_pings drains the outbox into one batched call.
      if (env) {
        if (was_created) {
          await triggerIndexNow(publicUrlFor("vendors", vendorSlug), env, "vendor-create-or-link", {
            defer: deferSearchPing,
            db,
            entity: { type: "vendor", id: vendorId, slug: vendorSlug, action: "create" },
          });
        }
        if ((was_linked || status_changed) && PUBLIC_VENDOR_SET.has(status)) {
          await triggerIndexNow(publicUrlFor("events", event.slug), env, "event-vendor-link", {
            defer: deferSearchPing,
            db,
            entity: {
              type: "event",
              id: event.id,
              slug: event.slug,
              action: "update",
            },
          });
        }
      }

      // 6. Audit log
      await db.insert(adminActions).values({
        action: "event_vendor.create_or_link",
        actorUserId: auth.userId,
        targetType: "event_vendor",
        targetId: eventVendorRowId,
        payloadJson: JSON.stringify({
          event_id: params.event_id,
          vendor_id: vendorId,
          was_created,
          was_linked,
          was_already_linked,
          status_changed,
          status,
          payment_status: paymentStatus,
          dedup_strategy: dedupStrategy,
          matched_existing: matchedExisting,
        }),
        createdAt: new Date(),
      });

      return {
        content: [
          jsonContent({
            vendor_id: vendorId,
            was_created,
            was_linked,
            was_already_linked,
            status_changed,
            matched_existing: matchedExisting,
          }),
        ],
      };
    }
  );
}

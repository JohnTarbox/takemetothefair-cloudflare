/**
 * @takemetothefair/vendor-linking — the ONE copy of the create-or-link-vendor
 * write tail.
 *
 * WHY THIS PACKAGE EXISTS: the dedup → create-if-needed → link-to-event → audit
 * logic used to live only in the MCP `create_or_link_vendor` tool. OPE-205's
 * booth-photo review needs the same write from the main app, and a second copy
 * of ~250 lines of vendor create/link/dedup rules is exactly the drift class
 * this repo has been bitten by (slug divergence #120; the geocode force/paging
 * bugs). So the logic lives here, and both the MCP tool and the app route are
 * thin adapters over `createOrLinkVendor`.
 *
 * PURE OF RUNTIME COUPLING: it imports only shared packages (utils / constants /
 * db-schema) and takes its two DB-integrity side-effects — completeness recompute
 * and enrichment logging — as injected deps, because each runtime already has its
 * own. The COSMETIC side-effects (IndexNow ping, post-create enrichment enqueue)
 * are deliberately NOT here: the core returns the flags a caller needs
 * (`wasCreated`, `linkIsPublic`, `vendorSlug`, `eventSlug`) and each adapter fires
 * those its own way. The core's job is the data, not the notifications.
 */
import { and, eq, isNull, like } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import {
  appendSlugSegment,
  createSlug,
  sanitizeProse,
  combinedSimilarity,
  getVendorComparisonString,
  type Slug,
} from "@takemetothefair/utils";
import {
  PUBLIC_VENDOR_STATUSES,
  VENDOR_STATUS_TRANSITIONS,
  type EventVendorStatus,
  type PaymentStatus,
  type ParticipationType,
} from "@takemetothefair/constants";

const { adminActions, eventDays, eventVendors, events, users, vendors } = schema;

/** Both runtimes' Db satisfy this (the app's adds `$client`, still assignable). */
export type VendorLinkDb = DrizzleD1Database<typeof schema>;

const PUBLIC_VENDOR_SET = new Set<string>(PUBLIC_VENDOR_STATUSES);
const FUZZY_THRESHOLD = 0.92;
const FUZZY_CANDIDATE_CAP = 200;
const REDIRECT_CHAIN_MAX_DEPTH = 5;

export const DEDUP_STRATEGY_VALUES = ["strict", "fuzzy", "skip"] as const;
export type DedupStrategy = (typeof DEDUP_STRATEGY_VALUES)[number];

/** SQLite LIKE-escape: strip the wildcard metacharacters. */
export function escapeLike(s: string): string {
  return s.replace(/[%_]/g, "");
}

/** "City, ST" → {city, state}. Splits on the LAST comma. */
export function parseLocation(location: string): { city: string | null; state: string | null } {
  const lastComma = location.lastIndexOf(",");
  if (lastComma === -1) return { city: location.trim() || null, state: null };
  const city = location.slice(0, lastComma).trim() || null;
  const state = location.slice(lastComma + 1).trim() || null;
  return { city, state };
}

/** Raw input — the adapter passes user/tool values; the core sanitizes. */
export interface CreateOrLinkVendorInput {
  eventId: string;
  businessName: string;
  type?: string | null;
  status?: EventVendorStatus;
  description?: string | null;
  products?: string[] | null;
  location?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  logoUrl?: string | null;
  dedupStrategy?: DedupStrategy;
  boothInfo?: string | null;
  paymentStatus?: PaymentStatus;
  participationType?: ParticipationType;
  /** K18 — per-occurrence scoping. null/omitted → series-wide. */
  eventDayId?: string | null;
}

/** DB-integrity side-effects each runtime supplies its own implementation of. */
export interface CreateOrLinkVendorDeps {
  /** The acting admin, or null for internal/system writes. */
  actorUserId: string | null;
  recomputeVendorCompleteness: (db: VendorLinkDb, vendorId: string) => Promise<unknown>;
  logEnrichment: (
    db: VendorLinkDb,
    entry: {
      targetType: "vendor";
      targetId: string;
      source: "mcp_create";
      status: "success";
      actorUserId?: string | null;
      notes?: string;
    }
  ) => Promise<void>;
}

export interface CreateOrLinkVendorSuccess {
  ok: true;
  vendorId: string;
  vendorSlug: Slug;
  eventSlug: string;
  eventVendorRowId: string;
  wasCreated: boolean;
  wasLinked: boolean;
  wasAlreadyLinked: boolean;
  statusChanged: boolean;
  matchedExisting: { name: string; similarity_score: number | null } | null;
  /** True when the link is in a public status — the adapter decides whether to
   *  ping IndexNow for the event. */
  linkIsPublic: boolean;
}

export interface CreateOrLinkVendorFailure {
  ok: false;
  error: string;
}

export type CreateOrLinkVendorResult = CreateOrLinkVendorSuccess | CreateOrLinkVendorFailure;

type VendorRow = {
  id: string;
  businessName: string;
  vendorType: string | null;
  redirectToVendorId: string | null;
  slug: Slug;
};

/** Resolve a vendor through its redirect_to_vendor_id chain to the canonical row. */
async function resolveRedirectChain(db: VendorLinkDb, startRow: VendorRow): Promise<VendorRow> {
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
    if (next.length === 0) return current; // dangling pointer → treat as canonical
    current = next[0];
  }
  throw new Error(
    `alias_cycle_detected: redirect chain exceeded max depth ${REDIRECT_CHAIN_MAX_DEPTH}`
  );
}

/**
 * Fuzzy candidate scan: narrow via a LIKE stem, then rank with combinedSimilarity.
 * Caps the in-memory set to bound CPU on large tables.
 */
async function findFuzzyMatch(
  db: VendorLinkDb,
  businessName: string,
  vendorType: string | null | undefined
): Promise<{ row: VendorRow; score: number } | null> {
  const stem = businessName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3)[0];

  const filters = [isNull(vendors.deletedAt)];
  if (stem) filters.push(like(vendors.businessName, `%${escapeLike(stem)}%`));

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
      const candidateExact = candidate.businessName.toLowerCase() === businessName.toLowerCase();
      const bestExact = best.row.businessName.toLowerCase() === businessName.toLowerCase();
      if (candidateExact && !bestExact) {
        best = { row: candidate, score };
        continue;
      }
      if (candidate.id < best.row.id) best = { row: candidate, score };
    }
  }

  return best;
}

/**
 * Dedup-search, create-if-needed, and link a vendor to an event in one call.
 * The single source of truth for this write; the MCP tool and the app route are
 * thin adapters. Never throws for expected failures — returns `{ok:false,error}`.
 */
export async function createOrLinkVendor(
  db: VendorLinkDb,
  input: CreateOrLinkVendorInput,
  deps: CreateOrLinkVendorDeps
): Promise<CreateOrLinkVendorResult> {
  const businessName = sanitizeProse(input.businessName ?? "");
  const vendorType = input.type != null ? sanitizeProse(input.type) : null;
  const description = input.description != null ? sanitizeProse(input.description) : null;
  const productsClean = Array.isArray(input.products)
    ? input.products.map((p) => sanitizeProse(p))
    : null;
  const status: EventVendorStatus = input.status ?? "CONFIRMED";
  const paymentStatus: PaymentStatus = input.paymentStatus ?? "NOT_REQUIRED";
  const participationType: ParticipationType = input.participationType ?? "EXHIBITOR";
  const dedupStrategy: DedupStrategy = input.dedupStrategy ?? "fuzzy";

  if (businessName.length === 0) {
    return { ok: false, error: "business_name is empty after sanitization." };
  }

  // 1. Event resolve
  const eventRows = await db
    .select({ id: events.id, slug: events.slug, name: events.name })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);
  if (eventRows.length === 0) {
    return { ok: false, error: `Event not found: ${input.eventId}` };
  }
  const event = eventRows[0];

  // 2. Dedup
  let matched: { row: VendorRow; score: number | null } | null = null;
  if (dedupStrategy !== "skip") {
    if (dedupStrategy === "strict") {
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
      if (strictRows.length > 0) matched = { row: strictRows[0], score: 1 };
    } else {
      const found = await findFuzzyMatch(db, businessName, vendorType);
      if (found) matched = { row: found.row, score: found.score };
    }

    if (matched) {
      try {
        const canonical = await resolveRedirectChain(db, matched.row);
        matched = { row: canonical, score: matched.score };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  let vendorId: string;
  let vendorSlug: Slug;
  let wasCreated = false;
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
      return { ok: false, error: "Could not generate a valid slug from the business name." };
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
        return { ok: false, error: "Too many slug collisions. Try a more unique business name." };
      }
    }

    const placeholderEmail = `pending+${finalSlug}@meetmeatthefair.com`;
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: placeholderEmail, role: "VENDOR" });

    const loc = input.location ? parseLocation(input.location) : { city: null, state: null };

    vendorId = crypto.randomUUID();
    await db.insert(vendors).values({
      id: vendorId,
      userId,
      businessName,
      slug: finalSlug,
      vendorType,
      description,
      products: productsClean ? JSON.stringify(productsClean) : "[]",
      website: input.website ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      logoUrl: input.logoUrl ?? null,
      city: loc.city,
      state: loc.state,
    });

    await deps.recomputeVendorCompleteness(db, vendorId);
    await deps.logEnrichment(db, {
      targetType: "vendor",
      targetId: vendorId,
      source: "mcp_create",
      status: "success",
      actorUserId: deps.actorUserId,
      notes: "create_or_link_vendor (new vendor)",
    });

    vendorSlug = finalSlug;
    wasCreated = true;
  }

  // 4. UPSERT event_vendors (K18 — validate optional per-occurrence scoping first)
  const eventDayId = input.eventDayId ?? null;
  if (eventDayId !== null) {
    const dayRows = await db
      .select({ id: eventDays.id, eventId: eventDays.eventId })
      .from(eventDays)
      .where(eq(eventDays.id, eventDayId))
      .limit(1);
    if (dayRows.length === 0) {
      return { ok: false, error: `event_day_id not found: ${eventDayId}` };
    }
    if (dayRows[0].eventId !== input.eventId) {
      return {
        ok: false,
        error: `event_day_id ${eventDayId} belongs to event ${dayRows[0].eventId}, not ${input.eventId}. Cross-event scoping is not allowed.`,
      };
    }
  }

  const linkRows = await db
    .select({
      id: eventVendors.id,
      status: eventVendors.status,
      paymentStatus: eventVendors.paymentStatus,
      participationType: eventVendors.participationType,
    })
    .from(eventVendors)
    .where(
      and(
        eq(eventVendors.eventId, input.eventId),
        eq(eventVendors.vendorId, vendorId),
        eventDayId === null
          ? isNull(eventVendors.eventDayId)
          : eq(eventVendors.eventDayId, eventDayId)
      )
    )
    .limit(1);

  let wasLinked = false;
  let wasAlreadyLinked = false;
  let statusChanged = false;
  let eventVendorRowId: string;

  if (linkRows.length === 0) {
    eventVendorRowId = crypto.randomUUID();
    await db.insert(eventVendors).values({
      id: eventVendorRowId,
      eventId: input.eventId,
      vendorId,
      status,
      paymentStatus,
      participationType,
      boothInfo: input.boothInfo ?? null,
      eventDayId,
    });
    wasLinked = true;
  } else {
    const existing = linkRows[0];
    eventVendorRowId = existing.id;
    wasAlreadyLinked = true;

    const updates: Record<string, unknown> = {};
    if (status !== existing.status) {
      const allowed = VENDOR_STATUS_TRANSITIONS[existing.status as EventVendorStatus];
      if (!allowed || !allowed.includes(status)) {
        return {
          ok: false,
          error: `Invalid transition: ${existing.status} → ${status}. Allowed from ${existing.status}: ${(allowed || []).join(", ") || "none"}.`,
        };
      }
      updates.status = status;
      statusChanged = true;
    }
    // Only update payment/participation when EXPLICITLY provided and different,
    // so a no-op call doesn't generate a phantom UPDATE with a defaulted value.
    if (input.paymentStatus !== undefined && input.paymentStatus !== existing.paymentStatus) {
      updates.paymentStatus = input.paymentStatus;
    }
    if (
      input.participationType !== undefined &&
      input.participationType !== existing.participationType
    ) {
      updates.participationType = input.participationType;
    }
    if (input.boothInfo !== undefined) updates.boothInfo = input.boothInfo;

    if (Object.keys(updates).length > 0) {
      await db.update(eventVendors).set(updates).where(eq(eventVendors.id, existing.id));
    }
  }

  // 5. Audit log
  await db.insert(adminActions).values({
    action: "event_vendor.create_or_link",
    actorUserId: deps.actorUserId,
    targetType: "event_vendor",
    targetId: eventVendorRowId,
    payloadJson: JSON.stringify({
      event_id: input.eventId,
      vendor_id: vendorId,
      event_day_id: eventDayId,
      was_created: wasCreated,
      was_linked: wasLinked,
      was_already_linked: wasAlreadyLinked,
      status_changed: statusChanged,
      status,
      payment_status: paymentStatus,
      dedup_strategy: dedupStrategy,
      matched_existing: matchedExisting,
    }),
    createdAt: new Date(),
  });

  return {
    ok: true,
    vendorId,
    vendorSlug,
    eventSlug: event.slug,
    eventVendorRowId,
    wasCreated,
    wasLinked,
    wasAlreadyLinked,
    statusChanged,
    matchedExisting,
    linkIsPublic: (wasLinked || statusChanged) && PUBLIC_VENDOR_SET.has(status),
  };
}

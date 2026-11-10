/**
 * OPE-1595 — one definition per admin list: its row shape, its filters, its
 * sort columns and its CSV columns.
 */
import { eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  events,
  performers,
  promoters,
  realUserWhere,
  users,
  vendors,
  venues,
} from "@/lib/db/schema";
import { containsCI, nameOrSlugContains } from "@takemetothefair/db-schema";
import { chunkIds } from "@takemetothefair/utils";
import type { Database } from "@/lib/db";
import { dismissedFlagIds } from "@/lib/duplicates/flag-queue";
import type { AdminList } from "./respond";
import type { ListParams } from "./params";
import type { Fields, ListQuery } from "./run-list";

type Sp = URLSearchParams;

function yesNoFilter(sp: Sp, param: string, condition: SQL | undefined, inverse: SQL | undefined) {
  const value = sp.get(param);
  if (value === "yes") return condition;
  if (value === "no") return inverse;
  return undefined;
}

/**
 * True when the row has no owner, or only an ingestion placeholder account.
 * It drives both the filter and the "Unclaimed" badge, so they cannot disagree.
 * `realUserWhere` is true for the all-NULL row of an unmatched LEFT JOIN, so
 * the missing-owner case needs its own arm.
 */
function unclaimedExpr(): SQL {
  return sql`(${users.id} IS NULL OR NOT (${realUserWhere()}))`;
}

function claimFilter(sp: Sp): SQL | undefined {
  const value = sp.get("claim");
  if (value === "unclaimed") return unclaimedExpr();
  if (value === "claimed") return sql`NOT ${unclaimedExpr()}`;
  return undefined;
}

function base(q: unknown): ListQuery {
  return q as ListQuery;
}

// ── Vendors ──────────────────────────────────────────────────────────────

export interface AdminVendorRow {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  verified: boolean;
  commercial: boolean;
  canSelfConfirm: boolean;
  deletedAt: Date | null;
  ownerEmail: string | null;
  unclaimed: boolean;
  eventCount: number;
}

export function vendorList(
  db: Database,
  sp: Sp,
  { q }: Pick<ListParams, "q">
): AdminList<AdminVendorRow> {
  const eventCount = sql<number>`(SELECT COUNT(*) FROM event_vendors ev WHERE ev.vendor_id = "vendors"."id")`;
  const deleted = sp.get("deleted");
  return {
    name: "vendors",
    spec: {
      base: (fields: Fields) =>
        base(db.select(fields).from(vendors).leftJoin(users, eq(vendors.userId, users.id))),
      lean:
        sp.get("claim") || sp.get("sort") === "user"
          ? undefined
          : (fields: Fields) => base(db.select(fields).from(vendors)),
      idColumn: vendors.id,
      fields: {
        id: vendors.id,
        businessName: vendors.businessName,
        slug: vendors.slug,
        vendorType: vendors.vendorType,
        verified: vendors.verified,
        commercial: vendors.commercial,
        canSelfConfirm: vendors.canSelfConfirm,
        deletedAt: vendors.deletedAt,
        ownerEmail: sql<
          string | null
        >`CASE WHEN ${unclaimedExpr()} THEN NULL ELSE ${users.email} END`,
        unclaimed: sql<boolean>`${unclaimedExpr()}`.mapWith(Boolean),
        eventCount: eventCount.mapWith(Number),
      },
      where: [
        // Same default as search_vendors: merge tombstones stay out of view.
        deleted === "only" ? isNotNull(vendors.deletedAt) : isNull(vendors.deletedAt),
        q
          ? or(
              nameOrSlugContains(q, vendors.businessName, vendors.slug),
              sql`${vendors.displayName} IS NOT NULL AND ${containsCI(vendors.displayName, q)}`
            )
          : undefined,
        yesNoFilter(sp, "verified", eq(vendors.verified, true), eq(vendors.verified, false)),
        yesNoFilter(sp, "commercial", eq(vendors.commercial, true), eq(vendors.commercial, false)),
        yesNoFilter(
          sp,
          "selfConfirm",
          eq(vendors.canSelfConfirm, true),
          eq(vendors.canSelfConfirm, false)
        ),
        claimFilter(sp),
      ],
      sortColumns: {
        // Raw order on purpose: idx_vendors_deleted_business_name serves it, so
        // the default page stops after 50 rows. NOCASE would sort all ~14K.
        businessName: { expr: vendors.businessName, notNull: true },
        vendorType: { expr: vendors.vendorType, nocase: true },
        user: { expr: users.email, nocase: true },
        events: { expr: eventCount },
        verified: { expr: vendors.verified },
        commercial: { expr: vendors.commercial },
        canSelfConfirm: { expr: vendors.canSelfConfirm },
      },
      defaultSort: { sort: "businessName", dir: "asc" },
    },
    csv: [
      { header: "id", value: (r) => r.id },
      { header: "business_name", value: (r) => r.businessName },
      { header: "slug", value: (r) => r.slug },
      { header: "type", value: (r) => r.vendorType },
      { header: "owner_email", value: (r) => r.ownerEmail },
      { header: "unclaimed", value: (r) => r.unclaimed },
      { header: "events", value: (r) => r.eventCount },
      { header: "verified", value: (r) => r.verified },
      { header: "commercial", value: (r) => r.commercial },
      { header: "self_confirm", value: (r) => r.canSelfConfirm },
      { header: "deleted_at", value: (r) => r.deletedAt },
    ],
  };
}

// ── Promoters ────────────────────────────────────────────────────────────

export interface AdminPromoterRow {
  id: string;
  companyName: string;
  slug: string;
  verified: boolean;
  ownerEmail: string | null;
  unclaimed: boolean;
  eventCount: number;
}

export function promoterList(
  db: Database,
  sp: Sp,
  { q }: Pick<ListParams, "q">
): AdminList<AdminPromoterRow> {
  const eventCount = sql<number>`(SELECT COUNT(*) FROM events e WHERE e.promoter_id = "promoters"."id")`;
  return {
    name: "promoters",
    spec: {
      base: (fields: Fields) =>
        base(db.select(fields).from(promoters).leftJoin(users, eq(promoters.userId, users.id))),
      idColumn: promoters.id,
      fields: {
        id: promoters.id,
        companyName: promoters.companyName,
        slug: promoters.slug,
        verified: promoters.verified,
        ownerEmail: sql<
          string | null
        >`CASE WHEN ${unclaimedExpr()} THEN NULL ELSE ${users.email} END`,
        unclaimed: sql<boolean>`${unclaimedExpr()}`.mapWith(Boolean),
        eventCount: eventCount.mapWith(Number),
      },
      where: [
        q ? nameOrSlugContains(q, promoters.companyName, promoters.slug) : undefined,
        yesNoFilter(sp, "verified", eq(promoters.verified, true), eq(promoters.verified, false)),
        claimFilter(sp),
      ],
      sortColumns: {
        companyName: { expr: promoters.companyName, nocase: true },
        user: { expr: users.email, nocase: true },
        events: { expr: eventCount },
        verified: { expr: promoters.verified },
      },
      defaultSort: { sort: "companyName", dir: "asc" },
    },
    csv: [
      { header: "id", value: (r) => r.id },
      { header: "company_name", value: (r) => r.companyName },
      { header: "slug", value: (r) => r.slug },
      { header: "owner_email", value: (r) => r.ownerEmail },
      { header: "unclaimed", value: (r) => r.unclaimed },
      { header: "events", value: (r) => r.eventCount },
      { header: "verified", value: (r) => r.verified },
    ],
  };
}

// ── Venues ───────────────────────────────────────────────────────────────

export interface AdminVenueRow {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  status: string;
  capacity: number | null;
  latitude: number | null;
  googlePlaceId: string | null;
  eventCount: number;
}

export function venueList(
  db: Database,
  sp: Sp,
  { q }: Pick<ListParams, "q">
): AdminList<AdminVenueRow> {
  const eventCount = sql<number>`(SELECT COUNT(*) FROM events e WHERE e.venue_id = "venues"."id")`;
  const status = sp.get("status");
  return {
    name: "venues",
    spec: {
      base: (fields: Fields) => base(db.select(fields).from(venues)),
      idColumn: venues.id,
      fields: {
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        city: venues.city,
        state: venues.state,
        status: venues.status,
        capacity: venues.capacity,
        latitude: venues.latitude,
        googlePlaceId: venues.googlePlaceId,
        eventCount: eventCount.mapWith(Number),
      },
      where: [
        q
          ? or(nameOrSlugContains(q, venues.name, venues.slug), containsCI(venues.city, q))
          : undefined,
        status ? eq(venues.status, status as typeof venues.$inferSelect.status) : undefined,
        sp.get("google") === "missing" ? isNull(venues.googlePlaceId) : undefined,
        sp.get("coords") === "missing" ? isNull(venues.latitude) : undefined,
      ],
      sortColumns: {
        name: { expr: venues.name, nocase: true },
        location: { expr: sql`${venues.city} || ', ' || ${venues.state}`, nocase: true },
        capacity: { expr: venues.capacity },
        events: { expr: eventCount },
        status: { expr: venues.status },
      },
      defaultSort: { sort: "name", dir: "asc" },
      stats: async () => {
        const [row] = await db
          .select({
            missingCoords: sql<number>`COALESCE(SUM(CASE WHEN ${venues.latitude} IS NULL THEN 1 ELSE 0 END), 0)`,
            missingGoogle: sql<number>`COALESCE(SUM(CASE WHEN ${venues.googlePlaceId} IS NULL THEN 1 ELSE 0 END), 0)`,
          })
          .from(venues);
        return {
          missingCoords: Number(row?.missingCoords ?? 0),
          missingGoogle: Number(row?.missingGoogle ?? 0),
        };
      },
    },
    csv: [
      { header: "id", value: (r) => r.id },
      { header: "name", value: (r) => r.name },
      { header: "slug", value: (r) => r.slug },
      { header: "city", value: (r) => r.city },
      { header: "state", value: (r) => r.state },
      { header: "status", value: (r) => r.status },
      { header: "capacity", value: (r) => r.capacity },
      { header: "events", value: (r) => r.eventCount },
      { header: "google_place_id", value: (r) => r.googlePlaceId },
    ],
  };
}

// ── Users ────────────────────────────────────────────────────────────────

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date | null;
  emailVerified: Date | null;
}

export function userList(
  db: Database,
  sp: Sp,
  { q }: Pick<ListParams, "q">
): AdminList<AdminUserRow> {
  const role = sp.get("role");
  return {
    name: "users",
    spec: {
      base: (fields: Fields) => base(db.select(fields).from(users)),
      idColumn: users.id,
      fields: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        emailVerified: users.emailVerified,
      },
      where: [
        sp.get("includePlaceholders") === "1" ? undefined : realUserWhere(),
        q ? or(containsCI(users.email, q), containsCI(users.name, q)) : undefined,
        role ? eq(users.role, role as typeof users.$inferSelect.role) : undefined,
      ],
      sortColumns: {
        email: { expr: users.email, nocase: true },
        name: { expr: users.name, nocase: true },
        role: { expr: users.role },
        createdAt: { expr: users.createdAt },
      },
      defaultSort: { sort: "email", dir: "asc" },
    },
    csv: [
      { header: "id", value: (r) => r.id },
      { header: "email", value: (r) => r.email },
      { header: "name", value: (r) => r.name },
      { header: "role", value: (r) => r.role },
      { header: "created_at", value: (r) => r.createdAt },
      { header: "email_verified", value: (r) => r.emailVerified },
    ],
  };
}

// ── Performers ───────────────────────────────────────────────────────────

export interface AdminPerformerRow {
  id: string;
  name: string;
  slug: string;
  verified: boolean;
  createdAt: Date | null;
}

export function performerList(
  db: Database,
  sp: Sp,
  { q }: Pick<ListParams, "q">
): AdminList<AdminPerformerRow> {
  return {
    name: "performers",
    spec: {
      base: (fields: Fields) => base(db.select(fields).from(performers)),
      idColumn: performers.id,
      fields: {
        id: performers.id,
        name: performers.name,
        slug: performers.slug,
        verified: performers.verified,
        createdAt: performers.createdAt,
      },
      where: [
        isNull(performers.deletedAt),
        q ? nameOrSlugContains(q, performers.name, performers.slug) : undefined,
        yesNoFilter(sp, "verified", eq(performers.verified, true), eq(performers.verified, false)),
      ],
      sortColumns: {
        name: { expr: performers.name, nocase: true },
        createdAt: { expr: performers.createdAt },
      },
      defaultSort: { sort: "createdAt", dir: "desc" },
    },
    csv: [
      { header: "id", value: (r) => r.id },
      { header: "name", value: (r) => r.name },
      { header: "slug", value: (r) => r.slug },
      { header: "verified", value: (r) => r.verified },
      { header: "created_at", value: (r) => r.createdAt },
    ],
  };
}

// ── Events ───────────────────────────────────────────────────────────────

export interface AdminEventRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date | null;
  endDate: Date | null;
  featured: boolean;
  gateFlags: string | null;
  flaggedForReview: number | boolean | null;
  possibleDuplicateOf: string | null;
  venueName: string | null;
  promoterName: string | null;
  blogPostCount: number;
  possibleDuplicate?: {
    id: string;
    name: string;
    slug: string;
    status: string;
    startDate: Date | null;
  } | null;
}

/** Attaches the MEDIUM-confidence dedup candidate, for this page's rows only. */
async function attachDuplicateCandidates(
  db: Database,
  rows: AdminEventRow[]
): Promise<AdminEventRow[]> {
  const flagged = rows.filter((r) => r.possibleDuplicateOf);
  if (flagged.length === 0) return rows;
  const ids = [...new Set(flagged.map((r) => r.possibleDuplicateOf as string))];
  const candidates = new Map<string, NonNullable<AdminEventRow["possibleDuplicate"]>>();
  for (const chunk of chunkIds(ids)) {
    const found = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        status: events.status,
        startDate: events.startDate,
      })
      .from(events)
      .where(inArray(events.id, chunk));
    for (const c of found)
      candidates.set(c.id, c as NonNullable<AdminEventRow["possibleDuplicate"]>);
  }
  const dismissed = await dismissedFlagIds(
    db,
    flagged.map((r) => r.id)
  );
  return rows.map((r) => ({
    ...r,
    possibleDuplicate:
      r.possibleDuplicateOf && !dismissed.has(r.id)
        ? (candidates.get(r.possibleDuplicateOf) ?? null)
        : null,
  }));
}

export function eventList(
  db: Database,
  sp: Sp,
  { q }: Pick<ListParams, "q">
): AdminList<AdminEventRow> {
  const blogPostCount = sql<number>`(
    SELECT COUNT(DISTINCT cl.source_id) FROM content_links cl
    INNER JOIN blog_posts bp ON bp.id = cl.source_id
    WHERE cl.source_type = 'BLOG_POST' AND cl.target_type = 'EVENT'
      AND cl.target_id = "events"."id" AND bp.status = 'PUBLISHED'
  )`;
  const gateFlagged = sql`(${events.gateFlags} IS NOT NULL AND ${events.gateFlags} != '' AND ${events.gateFlags} != '[]')`;
  const reviewFlagged = sql`COALESCE(${events.flaggedForReview}, 0) != 0`;
  const status = sp.get("status");
  const venue = sp.get("venue");
  const gate = sp.get("gate");
  const review = sp.get("review");
  const date = sp.get("date");
  return {
    name: "events",
    spec: {
      base: (fields: Fields) =>
        base(
          db
            .select(fields)
            .from(events)
            .leftJoin(venues, eq(events.venueId, venues.id))
            .leftJoin(promoters, eq(events.promoterId, promoters.id))
        ),
      lean:
        sp.get("sort") === "venue" || sp.get("sort") === "promoter"
          ? undefined
          : (fields: Fields) => base(db.select(fields).from(events)),
      idColumn: events.id,
      fields: {
        id: events.id,
        name: events.name,
        slug: events.slug,
        status: events.status,
        startDate: events.startDate,
        endDate: events.endDate,
        featured: events.featured,
        gateFlags: events.gateFlags,
        flaggedForReview: events.flaggedForReview,
        possibleDuplicateOf: events.possibleDuplicateOf,
        venueName: venues.name,
        promoterName: promoters.companyName,
        blogPostCount: blogPostCount.mapWith(Number),
      },
      where: [
        q ? nameOrSlugContains(q, events.name, events.slug) : undefined,
        status ? eq(events.status, status as typeof events.$inferSelect.status) : undefined,
        venue === "no-venue" ? isNull(events.venueId) : undefined,
        venue === "has-venue" ? isNotNull(events.venueId) : undefined,
        gate === "flagged" ? gateFlagged : undefined,
        gate === "clean" ? sql`NOT ${gateFlagged}` : undefined,
        review === "flagged" ? reviewFlagged : undefined,
        review === "clean" ? sql`NOT (${reviewFlagged})` : undefined,
        date === "needs-date" ? isNull(events.startDate) : undefined,
        date === "has-date" ? isNotNull(events.startDate) : undefined,
      ],
      sortColumns: {
        name: { expr: events.name, nocase: true },
        venue: { expr: venues.name, nocase: true },
        promoter: { expr: promoters.companyName, nocase: true },
        startDate: { expr: events.startDate },
        status: { expr: events.status },
        blogPostCount: { expr: blogPostCount },
      },
      defaultSort: { sort: "startDate", dir: "asc" },
      finish: (rows) => attachDuplicateCandidates(db, rows),
    },
    csv: [
      { header: "id", value: (r) => r.id },
      { header: "name", value: (r) => r.name },
      { header: "slug", value: (r) => r.slug },
      { header: "status", value: (r) => r.status },
      { header: "start_date", value: (r) => r.startDate },
      { header: "end_date", value: (r) => r.endDate },
      { header: "venue", value: (r) => r.venueName },
      { header: "promoter", value: (r) => r.promoterName },
      { header: "blog_posts", value: (r) => r.blogPostCount },
      { header: "gate_flags", value: (r) => r.gateFlags },
    ],
  };
}

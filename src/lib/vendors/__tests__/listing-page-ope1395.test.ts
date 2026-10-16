/**
 * OPE-1395 (IDX1) — the /vendors listing paginates per page instead of loading
 * every vendor + every vendor's events.
 *
 * The contract is "same page, cheaper". So the core assertion runs the
 * PRE-OPE-1395 algorithm (copied verbatim below as `legacyLoad`, from
 * src/app/vendors/(listing)/page.tsx at d160382b) and the new loader against
 * the same seeded database, for every filter combination and every page, and
 * requires deep equality — cards, order, events, totals.
 *
 * Then the cost half: the statements a page issues must not scale with the
 * vendor count (the old page ran ~230 sequential event batches), and none may
 * exceed D1's 100 bound-parameter cap (better-sqlite3 allows 32766, so a cap
 * breach would pass silently here — assert the statement SHAPE).
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { D1_MAX_BIND_PARAMS, searchSlugForm } from "@takemetothefair/utils";
import * as schema from "../../db/schema";
import { vendors, users, eventVendors, events, venues, userFavorites } from "../../db/schema";
import type { Database as AppDb } from "../../db";
import {
  collectBrandParentIdsToLoad,
  groupVendorsForListing,
  type GroupableVendor,
} from "../../vendor-listing-grouping";
import { isPubliclyVisibleVendorLink } from "../../vendor-status";
import { isPublicEventStatus } from "../../event-status";
import { upcomingEndPredicate } from "../../event-dates";
import { loadVendorListingPage, type VendorListingParams } from "../listing-page";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 86_400;
const nowSec = Math.floor(NOW.getTime() / 1000);

let raw: InstanceType<typeof Database>;
let db: AppDb;
let prepared: string[];

function run(sqlText: string, ...args: unknown[]) {
  raw.prepare(sqlText).run(...args);
}

function vendor(
  id: string,
  name: string,
  o: {
    type?: string;
    description?: string;
    displayName?: string;
    role?: "NATIONAL" | "LOCAL_OFFICE" | "INDEPENDENT";
    brand?: string;
    childDisplay?: "self" | "brand_parent" | "both";
    deleted?: boolean;
    verifiedOwner?: boolean;
    slug?: string;
  } = {}
) {
  run(
    "INSERT INTO users (id, email, email_verified) VALUES (?, ?, ?)",
    `u-${id}`,
    `${id}@example.com`,
    o.verifiedOwner ? nowSec - 100 * DAY : null
  );
  run(
    `INSERT INTO vendors (id, user_id, business_name, display_name, slug, description, vendor_type,
       role, brand_parent_vendor_id, default_child_display, display_override_permitted, display_mode,
       verified, commercial, claimed, enhanced_profile, verified_pro, deleted_at, city, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 0, 1, 0, 0, ?, 'Augusta', 'ME')`,
    id,
    `u-${id}`,
    name,
    o.displayName ?? null,
    o.slug ?? id,
    o.description ?? null,
    o.type ?? null,
    o.role ?? "INDEPENDENT",
    o.brand ?? null,
    o.childDisplay ?? null,
    o.deleted ? nowSec - DAY : null
  );
}

function event(
  id: string,
  startOffsetDays: number,
  o: { endOffsetDays?: number | null; status?: string; lifecycle?: string } = {}
) {
  run(
    `INSERT INTO events (id, name, slug, start_date, end_date, status, lifecycle_status, venue_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'venue-1')`,
    id,
    `Event ${id}`,
    `event-${id}`,
    nowSec + startOffsetDays * DAY,
    o.endOffsetDays === null ? null : nowSec + (o.endOffsetDays ?? startOffsetDays + 1) * DAY,
    o.status ?? "APPROVED",
    o.lifecycle ?? "SCHEDULED"
  );
}

let linkSeq = 0;
function link(vendorId: string, eventId: string, o: { status?: string; visible?: 0 | 1 } = {}) {
  run(
    "INSERT INTO event_vendors (id, event_id, vendor_id, status, public_visible) VALUES (?, ?, ?, ?, ?)",
    `ev-${++linkSeq}`,
    eventId,
    vendorId,
    o.status ?? "APPROVED",
    o.visible ?? 1
  );
}

function seed() {
  const types = ["Food", "Crafts", "Jewelry", null];
  // 140 independents — more than two 50-card pages — with duplicate names
  // (ordering ties) and a sprinkling of search terms and deleted rows.
  for (let i = 0; i < 140; i++) {
    const name = `Vendor ${String(Math.floor(i / 2)).padStart(3, "0")}`; // pairs tie
    vendor(`ind-${i}`, name, {
      type: types[i % 4] ?? undefined,
      description:
        i % 9 === 0 ? "Hand-poured maple candy" : i % 11 === 0 ? "ÉCLAIRS fresh" : undefined,
      deleted: i % 23 === 0,
      verifiedOwner: i % 3 === 0,
    });
  }
  vendor("unicode", "Aéhkō Pottery", { slug: "aehko-pottery", type: "Crafts" });

  // brand_parent-mode brand: offices collapse into one card at the first office's position.
  vendor("brandA", "Zeta Brand HQ", {
    role: "NATIONAL",
    childDisplay: "brand_parent",
    verifiedOwner: true,
  });
  vendor("offA1", "Alpha Office of Zeta", { role: "LOCAL_OFFICE", brand: "brandA", type: "Food" });
  vendor("offA2", "Vendor 010 Zeta Office", {
    role: "LOCAL_OFFICE",
    brand: "brandA",
    type: "Crafts",
  });
  vendor("offA3", "Deleted Zeta Office", { role: "LOCAL_OFFICE", brand: "brandA", deleted: true });
  // self-mode brand: hub suppressed, offices render as their own cards.
  vendor("brandB", "Beta Brand", { role: "NATIONAL", childDisplay: "self" });
  vendor("offB1", "Beta Office North", { role: "LOCAL_OFFICE", brand: "brandB", type: "Food" });
  vendor("offB2", "Beta Office South maple", { role: "LOCAL_OFFICE", brand: "brandB" });
  vendor("brandC", "Gamma Both", { role: "NATIONAL", childDisplay: "both", displayName: "Gamma" });
  // brand_parent brand whose ONLY upcoming event is on an office — the card
  // must still count as "has events" (aggregated ids, not the card's own id).
  vendor("brandD", "Delta Brand", { role: "NATIONAL", childDisplay: "brand_parent" });
  vendor("offD1", "Delta Office East", { role: "LOCAL_OFFICE", brand: "brandD" });

  // Events: upcoming, in-grace, past, null-end, non-public statuses.
  event("e-up1", 5);
  event("e-up2", 2);
  event("e-grace", -1, { endOffsetDays: -0.5 }); // ended 12h ago — inside the 24h grace
  event("e-past", -10);
  event("e-nullend", 3, { endOffsetDays: null });
  event("e-pending", 4, { status: "PENDING" });
  event("e-cancel", 6, { lifecycle: "CANCELLED" });
  event("e-tie", 5); // same start as e-up1

  for (let i = 0; i < 140; i += 7) link(`ind-${i}`, "e-up1");
  for (let i = 3; i < 140; i += 13) link(`ind-${i}`, "e-grace");
  for (let i = 5; i < 140; i += 17) link(`ind-${i}`, "e-past");
  link("ind-1", "e-nullend");
  link("ind-1", "e-up2");
  link("ind-1", "e-tie");
  link("ind-2", "e-pending");
  link("ind-4", "e-cancel");
  link("ind-6", "e-up2", { visible: 0 });
  link("ind-8", "e-up2", { status: "APPLIED" });
  link("offA2", "e-up2");
  link("offA3", "e-up1"); // deleted office's event still counted? (same as before: no — not loaded)
  link("brandA", "e-nullend");
  link("offB1", "e-up1");
  link("offD1", "e-up2");

  // favorites
  for (const id of ["ind-2", "offA1", "offB2", "unicode", "brandB"]) {
    run(
      "INSERT INTO user_favorites (id, user_id, favoritable_type, favoritable_id) VALUES (?, 'fan', 'VENDOR', ?)",
      `fav-${id}`,
      id
    );
  }
  run(
    "INSERT INTO user_favorites (id, user_id, favoritable_type, favoritable_id) VALUES ('fav-x', 'fan', 'EVENT', 'ind-10')"
  );
}

beforeEach(() => {
  raw = new Database(":memory:");
  for (const t of [users, vendors, events, eventVendors, venues, userFavorites])
    raw.exec(ddlFor(t));
  run(
    "INSERT INTO venues (id, name, slug, city, state) VALUES ('venue-1', 'Fairgrounds', 'fg', 'Union', 'ME')"
  );
  linkSeq = 0;
  seed();
  prepared = [];
  const originalPrepare = raw.prepare.bind(raw);
  raw.prepare = ((s: string) => {
    prepared.push(s);
    return originalPrepare(s);
  }) as typeof raw.prepare;
  db = drizzle(raw, { schema }) as unknown as AppDb;
});

// ── The pre-OPE-1395 algorithm, verbatim apart from taking `db`/`now` ──────
async function legacyLoad(searchParams: VendorListingParams & { favorites?: string }, now: Date) {
  const favoriteUserId = searchParams.favoriteUserId;
  const conditions: (ReturnType<typeof eq> | ReturnType<typeof isNull>)[] = [
    isNull(vendors.deletedAt),
  ];
  if (searchParams.type) conditions.push(eq(vendors.vendorType, searchParams.type));
  if (searchParams.favorites === "true" && favoriteUserId) {
    conditions.push(
      sql`${vendors.id} IN (SELECT ${userFavorites.favoritableId} FROM ${userFavorites} WHERE ${userFavorites.userId} = ${favoriteUserId} AND ${userFavorites.favoritableType} = 'VENDOR')`
    );
  } else if (searchParams.favorites === "true" && !favoriteUserId) {
    return [];
  }
  let vendorResults = await db
    .select()
    .from(vendors)
    .leftJoin(users, eq(vendors.userId, users.id))
    .where(and(...conditions))
    .orderBy(vendors.businessName);
  if (searchParams.q) {
    const lowerQuery = searchParams.q.toLowerCase();
    const slugQuery = searchSlugForm(searchParams.q);
    vendorResults = vendorResults.filter(
      (v) =>
        v.vendors.businessName.toLowerCase().includes(lowerQuery) ||
        v.vendors.displayName?.toLowerCase().includes(lowerQuery) ||
        v.vendors.description?.toLowerCase().includes(lowerQuery) ||
        v.vendors.vendorType?.toLowerCase().includes(lowerQuery) ||
        (slugQuery ? v.vendors.slug.includes(slugQuery) : false)
    );
  }
  if (vendorResults.length === 0) return [];
  const groupableMatches = vendorResults.map((v, idx) => ({
    rowIndex: idx,
    id: v.vendors.id,
    role: v.vendors.role,
    brandParentVendorId: v.vendors.brandParentVendorId,
    operatorParentVendorId: v.vendors.operatorParentVendorId,
    aliasOfVendorId: v.vendors.aliasOfVendorId,
    displayOverridePermitted: v.vendors.displayOverridePermitted,
    displayMode: v.vendors.displayMode,
    defaultChildDisplay: v.vendors.defaultChildDisplay,
  }));
  const matchedIds = new Set(vendorResults.map((v) => v.vendors.id));
  const brandParentIdsNeeded = collectBrandParentIdsToLoad(groupableMatches);
  const missingBrandParentIds = brandParentIdsNeeded.filter((id) => !matchedIds.has(id));
  type VendorRow = (typeof vendorResults)[number]["vendors"];
  const extraBrandParentRows: VendorRow[] =
    missingBrandParentIds.length > 0
      ? await db
          .select()
          .from(vendors)
          .where(and(inArray(vendors.id, missingBrandParentIds), isNull(vendors.deletedAt)))
      : [];
  const vendorRowById = new Map<string, VendorRow>();
  for (const v of vendorResults) vendorRowById.set(v.vendors.id, v.vendors);
  const ownerVerifiedById = new Map<string, boolean>();
  for (const v of vendorResults)
    ownerVerifiedById.set(v.vendors.id, Boolean(v.users?.emailVerified));
  for (const v of extraBrandParentRows) vendorRowById.set(v.id, v);
  const brandParentsForGrouping = new Map<string, GroupableVendor>();
  for (const id of brandParentIdsNeeded) {
    const row = vendorRowById.get(id);
    if (!row) continue;
    brandParentsForGrouping.set(id, {
      id: row.id,
      role: row.role,
      brandParentVendorId: row.brandParentVendorId,
      operatorParentVendorId: row.operatorParentVendorId,
      aliasOfVendorId: row.aliasOfVendorId,
      displayOverridePermitted: row.displayOverridePermitted,
      displayMode: row.displayMode,
      defaultChildDisplay: row.defaultChildDisplay,
    });
  }
  for (const v of vendorResults) {
    if (v.vendors.role === "NATIONAL") {
      brandParentsForGrouping.set(v.vendors.id, {
        id: v.vendors.id,
        role: v.vendors.role,
        brandParentVendorId: v.vendors.brandParentVendorId,
        operatorParentVendorId: v.vendors.operatorParentVendorId,
        aliasOfVendorId: v.vendors.aliasOfVendorId,
        displayOverridePermitted: v.vendors.displayOverridePermitted,
        displayMode: v.vendors.displayMode,
        defaultChildDisplay: v.vendors.defaultChildDisplay,
      });
    }
  }
  const brandIdsToCollapse: string[] = [];
  for (const [id, brand] of brandParentsForGrouping) {
    if (brand.defaultChildDisplay === "brand_parent") brandIdsToCollapse.push(id);
  }
  const allOfficesForCollapsed: VendorRow[] =
    brandIdsToCollapse.length > 0
      ? await db
          .select()
          .from(vendors)
          .where(
            and(inArray(vendors.brandParentVendorId, brandIdsToCollapse), isNull(vendors.deletedAt))
          )
      : [];
  for (const o of allOfficesForCollapsed) vendorRowById.set(o.id, o);
  const officesByBrandId = new Map<string, GroupableVendor[]>();
  for (const o of allOfficesForCollapsed) {
    if (!o.brandParentVendorId) continue;
    const arr = officesByBrandId.get(o.brandParentVendorId) ?? [];
    arr.push({
      id: o.id,
      role: o.role,
      brandParentVendorId: o.brandParentVendorId,
      operatorParentVendorId: o.operatorParentVendorId,
      aliasOfVendorId: o.aliasOfVendorId,
      displayOverridePermitted: o.displayOverridePermitted,
      displayMode: o.displayMode,
      defaultChildDisplay: o.defaultChildDisplay,
    });
    officesByBrandId.set(o.brandParentVendorId, arr);
  }
  const cards = groupVendorsForListing({
    matchedVendors: groupableMatches,
    brandParentsById: brandParentsForGrouping,
    officesByBrandId,
  });
  const vendorIdsSet = new Set<string>();
  for (const card of cards) for (const id of card.aggregatedEventVendorIds) vendorIdsSet.add(id);
  const vendorIds = [...vendorIdsSet];
  const BATCH_SIZE = 50;
  const allVendorEvents: {
    vendorId: string;
    eventId: string;
    eventName: string;
    eventSlug: string;
    startDate: Date | null;
    endDate: Date | null;
    imageUrl: string | null;
    venueName: string | null;
    venueCity: string | null;
    venueState: string | null;
  }[] = [];
  for (let i = 0; i < vendorIds.length; i += BATCH_SIZE) {
    const batch = vendorIds.slice(i, i + BATCH_SIZE);
    const batchResults = await db
      .select({
        vendorId: eventVendors.vendorId,
        eventId: events.id,
        eventName: events.name,
        eventSlug: events.slug,
        startDate: events.startDate,
        endDate: events.endDate,
        imageUrl: events.imageUrl,
        venueName: venues.name,
        venueCity: venues.city,
        venueState: venues.state,
      })
      .from(eventVendors)
      .innerJoin(events, eq(eventVendors.eventId, events.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(
        and(
          inArray(eventVendors.vendorId, batch),
          isPubliclyVisibleVendorLink(),
          isPublicEventStatus(),
          upcomingEndPredicate(now)
        )
      )
      .orderBy(asc(events.startDate));
    allVendorEvents.push(...batchResults);
  }
  const eventsByVendor = new Map<string, typeof allVendorEvents>();
  for (const ev of allVendorEvents) {
    const existing = eventsByVendor.get(ev.vendorId) || [];
    existing.push(ev);
    eventsByVendor.set(ev.vendorId, existing);
  }
  type AllVendorEvent = (typeof allVendorEvents)[number];
  let result = cards
    .map((card) => {
      const v = vendorRowById.get(card.vendorId);
      if (!v) return null;
      const eventById = new Map<string, AllVendorEvent>();
      for (const vid of card.aggregatedEventVendorIds) {
        for (const ev of eventsByVendor.get(vid) ?? []) {
          if (!eventById.has(ev.eventId)) eventById.set(ev.eventId, ev);
        }
      }
      const aggregatedEvents = [...eventById.values()].sort((a, b) => {
        const at = a.startDate?.getTime() ?? Infinity;
        const bt = b.startDate?.getTime() ?? Infinity;
        return at - bt;
      });
      return {
        id: v.id,
        ownerEmailVerified: ownerVerifiedById.get(v.id) ?? false,
        businessName: v.businessName,
        displayName: v.displayName,
        role: v.role,
        brandParentVendorId: v.brandParentVendorId,
        operatorParentVendorId: v.operatorParentVendorId,
        aliasOfVendorId: v.aliasOfVendorId,
        displayOverridePermitted: v.displayOverridePermitted,
        displayMode: v.displayMode,
        slug: v.slug,
        description: v.description,
        vendorType: v.vendorType,
        products: v.products,
        logoUrl: v.logoUrl,
        imageFocalX: v.imageFocalX,
        imageFocalY: v.imageFocalY,
        website: v.website,
        verified: v.verified,
        commercial: v.commercial,
        claimed: v.claimed,
        enhancedProfile: v.enhancedProfile,
        verifiedPro: v.verifiedPro,
        city: v.city,
        state: v.state,
        isBrandCollapsed: card.isBrandCollapsed,
        officeCount: card.isBrandCollapsed ? (officesByBrandId.get(v.id)?.length ?? 0) : undefined,
        events: aggregatedEvents.map((e) => ({
          id: e.eventId,
          name: e.eventName,
          slug: e.eventSlug,
          startDate: e.startDate,
          endDate: e.endDate,
          imageUrl: e.imageUrl,
          venue: e.venueName ? { name: e.venueName, city: e.venueCity, state: e.venueState } : null,
        })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (searchParams.hasEvents === "true") result = result.filter((v) => v.events.length > 0);
  return result;
}

const COMBOS: Array<VendorListingParams & { favorites?: string }> = [
  {},
  { type: "Food" },
  { type: "Crafts" },
  { q: "maple" },
  { q: "MAPLE" },
  { q: "éclairs" },
  { q: "aehko" },
  { q: "zeta" },
  { q: "beta" },
  { q: "office" },
  { q: "nothing-matches-this" },
  { hasEvents: "true" },
  { hasEvents: "true", type: "Food" },
  { hasEvents: "true", q: "zeta" },
  { favorites: "true", favoriteUserId: "fan" },
  { favorites: "true", favoriteUserId: "fan", hasEvents: "true" },
  { favorites: "true", favoriteUserId: "nobody" },
];

describe("OPE-1395 — the paginated loader renders exactly what the old page did", () => {
  it("the seed exercises what it claims (landmark)", async () => {
    const all = await legacyLoad({}, NOW);
    expect(all.length).toBeGreaterThan(100); // > two 50-card pages
    expect(all.some((v) => v.isBrandCollapsed)).toBe(true);
    expect(all.some((v) => v.events.length > 1)).toBe(true);
    expect(all.find((v) => v.id === "brandB")).toBeUndefined(); // self-mode hub suppressed
  });

  for (const pageSize of [50, 7]) {
    it.each(COMBOS)(`page size ${pageSize}: every page matches for %j`, async (combo) => {
      const legacy = await legacyLoad(combo, NOW);
      const pages = Math.max(1, Math.ceil(legacy.length / pageSize)) + 1; // +1: past the end
      for (let p = 1; p <= pages; p++) {
        const got = await loadVendorListingPage(
          db,
          {
            ...combo,
            favoriteUserId: combo.favorites === "true" ? combo.favoriteUserId : undefined,
          },
          { number: p, size: pageSize },
          NOW
        );
        expect(got.totalCount).toBe(legacy.length);
        expect(got.vendors).toEqual(legacy.slice((p - 1) * pageSize, p * pageSize));
      }
    });
  }
});

describe("OPE-1395 — a page's query cost does not scale with the vendor count", () => {
  function statementsFor(fn: () => Promise<unknown>) {
    return async () => {
      prepared = [];
      await fn();
      return [...prepared];
    };
  }

  it("issues a fixed handful of statements, none over D1's bind-parameter cap", async () => {
    for (const combo of COMBOS) {
      const stmts = await statementsFor(() =>
        loadVendorListingPage(db, combo, { number: 1, size: 50 }, NOW)
      )();
      // match set + brand parents + offices + hasEvents + page rows + page events
      expect(stmts.length, JSON.stringify(combo)).toBeLessThanOrEqual(6);
      for (const s of stmts) {
        expect((s.match(/\?/g) ?? []).length).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
      }
    }
  });

  it("does not read full vendor rows or events for vendors off the page", async () => {
    // The old page read events for every card (3 batches of 50 here; ~230 in
    // prod). Now exactly one event read covers page 1's cards.
    const stmts = await statementsFor(() =>
      loadVendorListingPage(db, {}, { number: 1, size: 50 }, NOW)
    )();
    const eventReads = stmts.filter((s) => /from "event_vendors" inner join "events"/i.test(s));
    expect(eventReads).toHaveLength(1);
    // The match-set read is the narrow projection: no description column.
    const matchRead = stmts.find((s) => /order by "vendors"."business_name"/i.test(s));
    expect(matchRead).toBeDefined();
    expect(matchRead).not.toMatch(/"vendors"."description"/);
  });
});

/**
 * OPE-1662 — the state and facet listing pages served from cached sets.
 *
 * Parity is asserted against the LIVE SQL path the pages ran before, on a real
 * SQLite database built from the Drizzle schema:
 *   1. a state page = a slice of the cached state set, total = its length,
 *      byte-for-byte equal (Dates included) to the old LIMIT/OFFSET read;
 *   2. a facet page = the cached facet index mapped onto that set, equal to
 *      `getFacetEvents` for type, region and month facets, with the same
 *      count, indexability depth and seasonality;
 *   3. the KV HIT path returns the same value as the miss — the codec keeps
 *      `Date`s as `Date`s (a plain JSON round-trip would not);
 *   4. a facet index that names an id the set lacks yields `null` (→ live read),
 *      never a short page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import { events, venues, promoters, eventVendors, vendors, eventDays } from "../../db/schema";
import type { ReadThroughKv } from "../../kv-read-through";
import { cacheRoundTrip, fromCacheable } from "../../cache-codec";
import {
  countStateEvents,
  facetPageFromSet,
  getCachedFacetIndex,
  getCachedFacetSeasonality,
  getCachedStateUpcomingSet,
  loadStateEventCards,
  pageSlice,
  stateSetCacheKey,
} from "../state-listing-cache";
import { countFacetForIndexing, getFacetEvents, getFacetSeasonality } from "../facet-query";
import { resolveFacet } from "../facets";
import { unsafeSlug } from "@takemetothefair/utils";

/** DDL generated from the schema (see occurrence-payload-ope581.test.ts for why). */
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType().toUpperCase();
    const type = t.includes("INT") ? "INTEGER" : t.includes("REAL") ? "REAL" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
// The production handle type; the better-sqlite3 handle runs the same builder.
const asListingDb = () => db as unknown as Parameters<typeof loadStateEventCards>[0];

function memoryKv() {
  const store = new Map<string, string>();
  const kv: ReadThroughKv = {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
  return { kv, store };
}

const DAY = 86_400_000;
const NOW = new Date();

async function seed() {
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Promo",
    slug: unsafeSlug("promo"),
    userId: "u1",
  } as typeof promoters.$inferInsert);
  await db.insert(venues).values([
    {
      id: "v-aug",
      name: "Augusta Civic",
      slug: unsafeSlug("aug"),
      address: "1 St",
      city: "Augusta",
      state: "ME",
      zip: "04330",
    },
    {
      id: "v-port",
      name: "Portland Expo",
      slug: unsafeSlug("port"),
      address: "2 St",
      city: "Portland",
      state: "me",
      zip: "04101",
    },
    {
      id: "v-nh",
      name: "Concord Hall",
      slug: unsafeSlug("conc"),
      address: "3 St",
      city: "Concord",
      state: "NH",
      zip: "03301",
    },
  ] as Array<typeof venues.$inferInsert>);

  const ev = (
    id: string,
    o: Partial<typeof events.$inferInsert> & { startOffsetDays: number; lenDays?: number }
  ): typeof events.$inferInsert => {
    const start = new Date(NOW.getTime() + o.startOffsetDays * DAY);
    start.setUTCHours(12, 0, 0, 0);
    const { startOffsetDays: _s, lenDays, ...rest } = o;
    return {
      id,
      name: `Event ${id}`,
      slug: unsafeSlug(`event-${id}`),
      promoterId: "p1",
      status: "APPROVED",
      lifecycleStatus: "SCHEDULED",
      startDate: start,
      endDate: new Date(start.getTime() + (lenDays ?? 0) * DAY),
      categories: JSON.stringify(["Craft Fair"]),
      ...rest,
    } as typeof events.$inferInsert;
  };

  await db.insert(events).values([
    ev("a1", { venueId: "v-aug", startOffsetDays: 3 }),
    ev("a2", { venueId: "v-aug", startOffsetDays: 3, categories: JSON.stringify(["Fair"]) }), // ties a1 on date
    ev("b1", { venueId: "v-port", startOffsetDays: 10, lenDays: 2 }),
    ev("b2", { venueId: "v-port", startOffsetDays: 20, status: "TENTATIVE" }),
    ev("c1", { venueId: null, stateCode: "me", startOffsetDays: 5 }), // venue-less, in state
    ev("c2", { venueId: null, stateCode: "NH", startOffsetDays: 6 }), // venue-less, out of state
    ev("d1", { venueId: "v-nh", startOffsetDays: 4 }), // out of state
    ev("e1", { venueId: "v-aug", startOffsetDays: -30 }), // past
    ev("e2", { venueId: "v-aug", startOffsetDays: 8, status: "PENDING" }), // not public
    ev("f1", { venueId: "v-aug", startOffsetDays: 40, lenDays: 1 }),
    ev("f2", { venueId: "v-port", startOffsetDays: 41 }),
  ]);

  await db.insert(vendors).values([
    { id: "vn1", userId: "u2", businessName: "Pottery Co", slug: unsafeSlug("pottery") },
    { id: "vn2", userId: "u3", businessName: "Maple Farm", slug: unsafeSlug("maple") },
  ] as Array<typeof vendors.$inferInsert>);
  await db.insert(eventVendors).values([
    { id: "ev1", eventId: "a1", vendorId: "vn1", status: "APPROVED", publicVisible: true },
    { id: "ev2", eventId: "a1", vendorId: "vn2", status: "CONFIRMED", publicVisible: true },
    { id: "ev3", eventId: "b1", vendorId: "vn2", status: "APPROVED", publicVisible: false }, // hidden
    { id: "ev4", eventId: "f1", vendorId: "vn1", status: "APPROVED", publicVisible: true },
  ] as Array<typeof eventVendors.$inferInsert>);

  const day = (offset: number) => new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);
  await db.insert(eventDays).values([
    { id: "d-b1-1", eventId: "b1", date: day(10), openTime: "09:00", closeTime: "17:00" },
    { id: "d-b1-2", eventId: "b1", date: day(11), openTime: "09:00", closeTime: "17:00" },
  ] as Array<typeof eventDays.$inferInsert>);
}

beforeEach(async () => {
  const raw = new Database(":memory:");
  for (const t of [promoters, venues, events, vendors, eventVendors, eventDays]) {
    raw.exec(ddlFor(t));
  }
  db = drizzle(raw, { schema });
  await seed();
});

describe("state page — cached set vs the live LIMIT/OFFSET read", () => {
  it("every page and the total match, with a positive landmark", async () => {
    const live = await loadStateEventCards(asListingDb(), "ME", { includePast: false });
    // Landmark: the fixture is not vacuous — 7 in-state upcoming public rows,
    // vendors attached (hidden link excluded), event-day dates attached.
    expect(live.map((e) => e.id)).toEqual(["a1", "a2", "c1", "b1", "b2", "f1", "f2"]);
    expect(live.find((e) => e.id === "a1")!.vendors).toHaveLength(2);
    expect(live.find((e) => e.id === "b1")!.vendors).toHaveLength(0);
    expect(live.find((e) => e.id === "b1")!.eventDayDates).toHaveLength(2);

    const { kv } = memoryKv();
    const cached = await getCachedStateUpcomingSet(asListingDb(), kv, "ME");
    expect(cached.length).toBe(await countStateEvents(asListingDb(), "ME", false));

    const LIMIT = 2;
    for (const page of [0, 1, 2, 3, 4, 5, 99]) {
      const offset = (page - 1) * LIMIT;
      const livePage = await loadStateEventCards(asListingDb(), "ME", {
        includePast: false,
        limit: LIMIT,
        offset,
      });
      expect(pageSlice(cached, page, LIMIT)).toEqual(livePage);
    }
  });

  it("a KV hit returns the same value as the miss, Dates still Dates", async () => {
    const { kv, store } = memoryKv();
    const miss = await getCachedStateUpcomingSet(asListingDb(), kv, "ME");
    expect(store.has(stateSetCacheKey("ME"))).toBe(true);
    const hit = await getCachedStateUpcomingSet(asListingDb(), kv, "ME");
    expect(hit).toEqual(miss);
    expect(hit[0].startDate).toBeInstanceOf(Date);
    expect(hit[0].endDate).toBeInstanceOf(Date);
    // …and equal to the uncached live read.
    expect(hit).toEqual(await loadStateEventCards(asListingDb(), "ME", { includePast: false }));
  });

  it("the hit path reads no D1", async () => {
    const { kv } = memoryKv();
    await getCachedStateUpcomingSet(asListingDb(), kv, "ME");
    const spy = vi.spyOn(db, "select");
    await getCachedStateUpcomingSet(asListingDb(), kv, "ME");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a plain JSON round-trip would NOT be a hit-safe cache (why the codec exists)", async () => {
    const live = await loadStateEventCards(asListingDb(), "ME", { includePast: false });
    expect(JSON.parse(JSON.stringify(live))[0].startDate).not.toBeInstanceOf(Date);
    expect(fromCacheable<typeof live>(cacheRoundTrip(live))).toEqual(live);
  });
});

describe("facet pages — cached index ∘ state set vs getFacetEvents", () => {
  const FACETS = ["craft-fairs", "fairs", "kennebec-valley"];

  it.each(FACETS)("%s: every page, the count, depth and seasonality match", async (slug) => {
    const facet = resolveFacet("maine", slug, NOW)!;
    expect(facet).not.toBeNull();
    const { kv } = memoryKv();
    const index = await getCachedFacetIndex(asListingDb(), kv, "ME", "maine", facet, NOW);
    const set = await getCachedStateUpcomingSet(asListingDb(), kv, "ME");

    const LIMIT = 2;
    const live1 = await getFacetEvents(asListingDb(), "ME", "maine", facet, NOW, 1, LIMIT);
    expect(index.ids.length).toBe(live1.total);
    expect(live1.total).toBeGreaterThan(0); // landmark: each facet matches something
    for (const page of [1, 2, 3, 4, 50]) {
      const live = await getFacetEvents(asListingDb(), "ME", "maine", facet, NOW, page, LIMIT);
      expect(facetPageFromSet(index, set, page, LIMIT)).toEqual(live.events);
    }
    expect(index.depth).toBe(await countFacetForIndexing(asListingDb(), "ME", "maine", facet, NOW));
    expect(await getCachedFacetSeasonality(asListingDb(), kv, "ME", "maine", facet, NOW)).toEqual(
      await getFacetSeasonality(asListingDb(), "ME", "maine", facet, NOW)
    );
  });

  it("the facet fixture is discriminating: types and regions select different rows", async () => {
    const { kv } = memoryKv();
    const ids = async (slug: string) =>
      (
        await getCachedFacetIndex(
          asListingDb(),
          kv,
          "ME",
          "maine",
          resolveFacet("maine", slug, NOW)!,
          NOW
        )
      ).ids;
    expect(await ids("fairs")).toEqual(["a2"]);
    expect(await ids("kennebec-valley")).toEqual(["a1", "a2", "f1"]);
  });

  it("an id missing from the set yields null (→ live read), never a short page", () => {
    const index = { ids: ["a1", "zz"], depth: 2 };
    expect(facetPageFromSet(index, [{ id: "a1" }], 1, 30)).toBeNull();
    expect(facetPageFromSet(index, [{ id: "a1" }], 2, 30)).toEqual([]);
  });
});

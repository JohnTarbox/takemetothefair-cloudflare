/**
 * OPE-1668 — the main /events listing served from one cached set.
 *
 * Parity is asserted against the LIVE SQL path (`loadEventsListingLive`, the
 * code the page ran before, moved verbatim) on a real SQLite database built
 * from the Drizzle schema. For every filter, every sort and a few combinations:
 * every page, the total, and the calendar (unpaged) answer must be equal —
 * Dates included — between the live read and the cached set.
 *
 * The fixture is built so each in-memory port is DISCRIMINATING: each filter
 * selects a different, non-empty, non-total subset, and the edge cases a naive
 * port gets wrong are present (NULL categories, `commercial_vendors_allowed`
 * NULL vs 0, ASCII-only case folding, a lowercase "farmers market" in a name,
 * name and date and view-count ties, a non-ASCII name under BINARY collation).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import { events, venues, promoters, eventVendors, vendors, eventDays } from "../../db/schema";
import type { ReadThroughKv } from "../../kv-read-through";
import {
  canServeEventsFromCache,
  getCachedEventCategories,
  getCachedEventStates,
  getCachedEventsUpcomingSet,
  loadEventsListingCached,
  loadEventsListingLive,
  type EventsListingParams,
} from "../events-listing";
import { unsafeSlug } from "@takemetothefair/utils";

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
const asListingDb = () => db as unknown as Parameters<typeof loadEventsListingLive>[0];

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
const dayStr = (offset: number) =>
  new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);

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
      name: "Augusta",
      slug: unsafeSlug("aug"),
      address: "1",
      city: "Augusta",
      state: "ME",
      zip: "04330",
    },
    {
      id: "v-port",
      name: "Portland",
      slug: unsafeSlug("port"),
      address: "2",
      city: "Portland",
      state: "me",
      zip: "04101",
    },
    {
      id: "v-nh",
      name: "Concord",
      slug: unsafeSlug("conc"),
      address: "3",
      city: "Concord",
      state: "NH",
      zip: "03301",
    },
    {
      id: "v-ma",
      name: "Boston",
      slug: unsafeSlug("bos"),
      address: "4",
      city: "Boston",
      state: "MA",
      zip: "02101",
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
      viewCount: 0,
      ...rest,
    } as typeof events.$inferInsert;
  };

  await db.insert(events).values([
    ev("e01", {
      venueId: "v-aug",
      startOffsetDays: 3,
      name: "Alpha Fair",
      featured: true,
      commercialVendorsAllowed: true,
      indoorOutdoor: "INDOOR",
      eventScale: "SMALL",
      viewCount: 10,
    }),
    // Ties e01 on date AND view count; lowercase name sorts after "Alpha" in BINARY.
    ev("e02", {
      venueId: "v-aug",
      startOffsetDays: 3,
      name: "alpha fair",
      categories: JSON.stringify(["Fair"]),
      featured: false,
      commercialVendorsAllowed: false,
      indoorOutdoor: "OUTDOOR",
      eventScale: "LARGE",
      viewCount: 10,
    }),
    // Venue-less, in ME; NULL categories, NULL commercial flag, NULL view count.
    ev("e03", {
      venueId: null,
      stateCode: "me",
      startOffsetDays: 5,
      name: "Bath Farmers Market",
      categories: null,
      commercialVendorsAllowed: null,
      viewCount: null,
    }),
    ev("e04", {
      venueId: "v-nh",
      startOffsetDays: 4,
      name: "Concord Market",
      categories: JSON.stringify(["Farmers Market"]),
      indoorOutdoor: "BOTH",
      viewCount: 50,
    }),
    // Discontinuous with event_days (one vendor-only); upper-case category; a
    // non-ASCII category that ASCII-only folding must NOT match "ébéniste".
    ev("e05", {
      venueId: "v-port",
      startOffsetDays: 10,
      lenDays: 2,
      discontinuousDates: true,
      name: "Élan Show",
      categories: JSON.stringify(["CRAFT FAIR", "Ébéniste"]),
      eventScale: "LARGE",
      viewCount: 3,
    }),
    ev("e06", {
      venueId: "v-nh",
      startOffsetDays: 20,
      status: "TENTATIVE",
      name: "Zeta Fest",
      categories: JSON.stringify(["Festival"]),
      featured: true,
    }),
    ev("e07", { venueId: "v-aug", startOffsetDays: -30 }), // past
    ev("e08", { venueId: "v-aug", startOffsetDays: 8, status: "PENDING" }), // not public
    // Season-long: starts tomorrow, runs ~4 months, but its only event_day is in 60d —
    // so `when=week` must drop it (OPE-48) while `when=month` keeps it.
    ev("e09", {
      venueId: "v-aug",
      startOffsetDays: 1,
      lenDays: 120,
      name: "Season Market",
      categories: JSON.stringify(["Market"]),
    }),
    ev("e10", { venueId: "v-ma", startOffsetDays: 1, name: "Boston Bazaar", viewCount: 7 }),
    // Lowercase "farmers market" in the NAME, not the categories.
    ev("e11", {
      venueId: "v-ma",
      startOffsetDays: 2,
      name: "Big farmers market day",
      categories: JSON.stringify(["Market"]),
      lenDays: 6,
    }),
    ev("e12", { venueId: "v-nh", startOffsetDays: 45, name: "Late Fair", viewCount: 10 }),
  ]);

  await db.insert(vendors).values([
    { id: "vn1", userId: "u2", businessName: "Pottery Co", slug: unsafeSlug("pottery") },
    { id: "vn2", userId: "u3", businessName: "Maple Farm", slug: unsafeSlug("maple") },
  ] as Array<typeof vendors.$inferInsert>);
  await db.insert(eventVendors).values([
    { id: "ev1", eventId: "e01", vendorId: "vn1", status: "APPROVED", publicVisible: true },
    { id: "ev2", eventId: "e01", vendorId: "vn2", status: "CONFIRMED", publicVisible: true },
    { id: "ev3", eventId: "e05", vendorId: "vn2", status: "APPROVED", publicVisible: false },
    { id: "ev4", eventId: "e12", vendorId: "vn1", status: "APPROVED", publicVisible: true },
  ] as Array<typeof eventVendors.$inferInsert>);

  await db.insert(eventDays).values([
    { id: "d1", eventId: "e05", date: dayStr(10), openTime: "09:00", closeTime: "17:00" },
    { id: "d2", eventId: "e05", date: dayStr(12), openTime: "10:00", closeTime: "16:00" },
    { id: "d3", eventId: "e05", date: dayStr(9), vendorOnly: true },
    { id: "d4", eventId: "e09", date: dayStr(60) },
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

const LIMIT = 2;

async function assertParity(p: EventsListingParams) {
  const { kv } = memoryKv();
  // Calendar (unpaged) first: it is the full ordered answer, and the landmark.
  const liveCal = await loadEventsListingLive(asListingDb(), p, {
    page: 1,
    limit: LIMIT,
    isCalendarView: true,
    now: NOW,
  });
  const cachedCal = await loadEventsListingCached(asListingDb(), kv, p, {
    page: 1,
    limit: LIMIT,
    isCalendarView: true,
    now: NOW,
  });
  expect(cachedCal).toEqual(liveCal);

  const pages = Math.max(1, Math.ceil(liveCal.total / LIMIT)) + 1; // +1: an empty overshoot page
  for (let page = 1; page <= pages; page++) {
    const live = await loadEventsListingLive(asListingDb(), p, {
      page,
      limit: LIMIT,
      isCalendarView: false,
      now: NOW,
    });
    const cached = await loadEventsListingCached(asListingDb(), kv, p, {
      page,
      limit: LIMIT,
      isCalendarView: false,
      now: NOW,
    });
    expect(cached).toEqual(live);
  }
  return liveCal.events.map((e) => e.id);
}

const ALL_UPCOMING = ["e09", "e10", "e11", "e01", "e02", "e04", "e03", "e05", "e06", "e12"];

describe("cached /events vs the live SQL — every filter, page and total", () => {
  it("unfiltered: the set is every upcoming public event (landmark)", async () => {
    const ids = await assertParity({});
    expect(ids).toEqual(ALL_UPCOMING);
  });

  // Each in-memory port must select a strict, non-empty subset — otherwise a
  // parity pass would not show the port does anything.
  const COLUMN_FILTERS: Array<[string, EventsListingParams]> = [
    ["category (ASCII case-insensitive)", { category: "craft fair" }],
    ["category (substring)", { category: "Fair" }],
    ["category (non-ASCII is NOT folded)", { category: "ébéniste" }],
    ["featured", { featured: "true" }],
    ["commercialVendors (NULL stays in, 0 is out)", { commercialVendors: "true" }],
    [
      "excludeFarmersMarkets (categories + name, case-insensitive)",
      { excludeFarmersMarkets: "true" },
    ],
    ["indoorOutdoor", { indoorOutdoor: "INDOOR" }],
    ["scale", { scale: "LARGE" }],
    ["when=month (start-date cap)", { when: "month" }],
  ];
  it.each(COLUMN_FILTERS)("%s", async (_label, p) => {
    const ids = await assertParity(p);
    expect(ids.length).toBeLessThan(ALL_UPCOMING.length);
    // "ébéniste" is the one filter whose correct answer is empty.
    if (p.category !== "ébéniste") expect(ids.length).toBeGreaterThan(0);
  });

  const SQL_PREDICATES: Array<[string, EventsListingParams]> = [
    ["state=ME (venue + venue-less, mixed case)", { state: "ME" }],
    ["state=me", { state: "me" }],
    ["state=NH", { state: "NH" }],
    ["when=week (event_days occurrence test)", { when: "week" }],
    ["when=weekend", { when: "weekend" }],
    ["days=weekday-any", { days: "weekday-any" }],
    ["days=weekday-only", { days: "weekday-only" }],
    ["days=weekend-any", { days: "weekend-any" }],
    ["days=weekend-only", { days: "weekend-only" }],
  ];
  it.each(SQL_PREDICATES)("%s", async (_label, p) => {
    await assertParity(p);
  });

  it("state filters are discriminating", async () => {
    expect(await assertParity({ state: "ME" })).toEqual(["e09", "e01", "e02", "e03", "e05"]);
    expect(await assertParity({ state: "NH" })).toEqual(["e04", "e06", "e12"]);
  });

  it("when=week drops the season-long event whose next day is weeks out; month keeps it", async () => {
    expect(await assertParity({ when: "week" })).not.toContain("e09");
    expect(await assertParity({ when: "month" })).toContain("e09");
  });

  it.each(["date-asc", "date-desc", "name-asc", "name-desc", "popular", "bogus"])(
    "sort=%s (ties broken by id, BINARY name order, NULL view count)",
    async (sort) => {
      await assertParity({ sort });
    }
  );

  it("sorts differ from each other (the sort port is not a no-op)", async () => {
    const byName = await assertParity({ sort: "name-asc" });
    const byPopular = await assertParity({ sort: "popular" });
    expect(byName).not.toEqual(ALL_UPCOMING);
    expect(byPopular).not.toEqual(ALL_UPCOMING);
    expect(byName.at(-1)).toBe("e05"); // "Élan Show" sorts after every ASCII name
    expect(byName.indexOf("e01")).toBeLessThan(byName.indexOf("e02")); // "Alpha" < "alpha"
  });

  it.each<[string, EventsListingParams]>([
    ["state + category + name sort", { state: "ME", category: "fair", sort: "name-asc" }],
    [
      "month + excludeFarmersMarkets + popular",
      { when: "month", excludeFarmersMarkets: "true", sort: "popular" },
    ],
    ["days + state + featured", { days: "weekday-any", state: "NH", featured: "true" }],
    ["week + scale + date-desc", { when: "week", scale: "LARGE", sort: "date-desc" }],
  ])("combination: %s", async (_label, p) => {
    await assertParity(p);
  });
});

describe("the cached path's contract", () => {
  it("routes free-text, per-user, includePast, vendor calendars and odd states to the live path", () => {
    const cards = { isCalendarView: false };
    expect(canServeEventsFromCache({}, cards)).toBe(true);
    expect(
      canServeEventsFromCache({ state: "me", category: "x", days: "weekend-only" }, cards)
    ).toBe(true);
    expect(canServeEventsFromCache({ query: "fair" }, cards)).toBe(false);
    expect(canServeEventsFromCache({ myEvents: "true" }, cards)).toBe(false);
    expect(canServeEventsFromCache({ favorites: "true" }, cards)).toBe(false);
    expect(canServeEventsFromCache({ includePast: "true" }, cards)).toBe(false);
    expect(canServeEventsFromCache({ state: "Maine" }, cards)).toBe(false);
    expect(canServeEventsFromCache({ state: "ß" }, cards)).toBe(false);
    expect(canServeEventsFromCache({}, { isCalendarView: true, includeVendorDays: false })).toBe(
      true
    );
    expect(canServeEventsFromCache({}, { isCalendarView: true, includeVendorDays: true })).toBe(
      false
    );
  });

  it("a KV hit equals the miss, Dates still Dates, and reads no D1", async () => {
    const { kv } = memoryKv();
    const p = { category: "fair", sort: "popular" };
    const opts = { page: 1, limit: LIMIT, isCalendarView: false, now: NOW };
    const miss = await loadEventsListingCached(asListingDb(), kv, p, opts);
    const spy = vi.spyOn(db, "select");
    const hit = await loadEventsListingCached(asListingDb(), kv, p, opts);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(hit).toEqual(miss);
    expect(hit.events[0].startDate).toBeInstanceOf(Date);
  });

  it("the calendar set carries eventDayHours (public days only); a card page does not", async () => {
    const { kv } = memoryKv();
    const set = await getCachedEventsUpcomingSet(asListingDb(), kv, NOW);
    const e05 = set.find((e) => e.id === "e05")!;
    expect(e05.eventDayHours?.map((h) => h.date)).toEqual([dayStr(10), dayStr(12)]);
    const cards = await loadEventsListingCached(
      asListingDb(),
      kv,
      { scale: "LARGE" },
      {
        page: 1,
        limit: 30,
        isCalendarView: false,
        now: NOW,
      }
    );
    expect(cards.events.find((e) => e.id === "e05")).toBeDefined();
    expect(cards.events.some((e) => "eventDayHours" in e)).toBe(false);
  });

  it("sidebar categories and states: cached value equals a fresh read; the hit reads no D1", async () => {
    const { kv } = memoryKv();
    const cats = await getCachedEventCategories(asListingDb(), kv);
    expect(cats).toContain("Craft Fair");
    expect(cats).toContain("Ébéniste");
    const states = await getCachedEventStates(asListingDb(), kv);
    expect(states).toEqual(expect.arrayContaining(["ME", "NH", "MA"]));
    const spy = vi.spyOn(db, "selectDistinct");
    const spy2 = vi.spyOn(db, "select");
    expect(await getCachedEventStates(asListingDb(), kv)).toEqual(states);
    expect(await getCachedEventCategories(asListingDb(), kv)).toEqual(cats);
    expect(spy).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
    spy.mockRestore();
    spy2.mockRestore();
  });
});

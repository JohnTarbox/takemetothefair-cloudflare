/**
 * OPE-1668 (ask 2) — the category routes and /events/past served from cached
 * sets. Parity against the LIVE query each page ran before (moved verbatim to
 * listing-family-cache.ts), on a real SQLite database built from the schema:
 * every page and the total, Dates included, for each category and for past
 * events across state/category keys.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import { events, venues, promoters, eventVendors, vendors, eventDays } from "../../db/schema";
import type { ReadThroughKv } from "../../kv-read-through";
import {
  countCategoryEvents,
  getCachedCategoryUpcomingSet,
  getCachedPastIndex,
  loadCategoryEventCards,
  loadPastEventsCached,
  loadPastEventsLive,
  type PastListingParams,
} from "../listing-family-cache";
import { pageSlice } from "../state-listing-cache";
import { CATEGORY_MAP } from "@/components/events/category-events-page";
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
const asListingDb = () => db as unknown as Parameters<typeof loadCategoryEventCards>[0];

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
      id: "v-me",
      name: "Augusta",
      slug: unsafeSlug("aug"),
      address: "1",
      city: "Augusta",
      state: "ME",
      zip: "04330",
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
      categories: JSON.stringify(["Fair"]),
      ...rest,
    } as typeof events.$inferInsert;
  };

  await db.insert(events).values([
    // Upcoming — ties on date (u1/u2), mixed categories, case variants.
    ev("u1", { venueId: "v-me", startOffsetDays: 3 }),
    ev("u2", { venueId: "v-nh", startOffsetDays: 3, categories: JSON.stringify(["Craft Fair"]) }),
    ev("u3", { venueId: "v-me", startOffsetDays: 6, categories: JSON.stringify(["FESTIVAL"]) }),
    ev("u4", {
      venueId: null,
      stateCode: "ME",
      startOffsetDays: 9,
      categories: JSON.stringify(["Farmers Market"]),
    }),
    ev("u5", {
      venueId: "v-me",
      startOffsetDays: 12,
      categories: JSON.stringify(["Market", "Craft Show"]),
    }),
    ev("u6", { venueId: "v-nh", startOffsetDays: 15, categories: null }),
    ev("u7", { venueId: "v-me", startOffsetDays: 18, status: "PENDING" }), // not public
    ev("u8", {
      venueId: "v-me",
      startOffsetDays: 21,
      categories: JSON.stringify(["Fair", "Festival"]),
    }),
  ]);

  // Past rows are inserted in REVERSE listing order, so SQLite's rowid order
  // (what an un-tiebroken sort or an un-reordered `IN (…)` read returns) is
  // NOT the right answer — otherwise a missing tiebreak or a missing re-order
  // would pass by luck. Ties on end date: q1/q2/q3.
  await db.insert(events).values([
    ev("q7", { venueId: "v-me", startOffsetDays: -130, status: "REJECTED" }), // not public
    ev("q6", { venueId: "v-me", startOffsetDays: -100, categories: null }),
    // The most recent past event, yet not first by id — so a page's `IN (…)`
    // read (which returns id order) must be re-ordered to match the index.
    ev("q5", { venueId: "v-nh", startOffsetDays: -5 }),
    ev("q4", {
      venueId: "v-me",
      startOffsetDays: -40,
      lenDays: 2,
      categories: JSON.stringify(["craft fair"]),
    }),
    ev("q3", { venueId: null, stateCode: "ME", startOffsetDays: -10 }),
    ev("q2", { venueId: "v-nh", startOffsetDays: -10, categories: JSON.stringify(["Festival"]) }),
    ev("q1", { venueId: "v-me", startOffsetDays: -10 }),
  ]);

  await db.insert(vendors).values([
    {
      id: "vn1",
      userId: "u2",
      businessName: "Pottery Co",
      displayName: "Pottery!",
      slug: unsafeSlug("pottery"),
    },
  ] as Array<typeof vendors.$inferInsert>);
  await db.insert(eventVendors).values([
    { id: "ev1", eventId: "u1", vendorId: "vn1", status: "APPROVED", publicVisible: true },
    { id: "ev2", eventId: "q4", vendorId: "vn1", status: "APPROVED", publicVisible: true },
    { id: "ev3", eventId: "q5", vendorId: "vn1", status: "APPROVED", publicVisible: false }, // hidden
  ] as Array<typeof eventVendors.$inferInsert>);
  const dayStr = (o: number) => new Date(NOW.getTime() + o * DAY).toISOString().slice(0, 10);
  await db.insert(eventDays).values([
    { id: "d1", eventId: "q4", date: dayStr(-40) },
    { id: "d2", eventId: "q4", date: dayStr(-38) },
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

describe("category routes — cached set vs the live paged read", () => {
  it.each(Object.entries(CATEGORY_MAP))(
    "%s: every page and the total match",
    async (_slug, cat) => {
      const { kv } = memoryKv();
      const set = await getCachedCategoryUpcomingSet(asListingDb(), kv, cat.category, NOW);
      expect(set.length).toBe(await countCategoryEvents(asListingDb(), cat.category, false, NOW));
      for (const page of [0, 1, 2, 3, 4, 99]) {
        const live = await loadCategoryEventCards(asListingDb(), cat.category, {
          includePast: false,
          limit: LIMIT,
          offset: (page - 1) * LIMIT,
          now: NOW,
        });
        expect(pageSlice(set, page, LIMIT)).toEqual(live);
      }
    }
  );

  it("is discriminating, case-insensitive like LIKE, and keeps display_name (landmark)", async () => {
    const { kv } = memoryKv();
    const ids = async (c: string) =>
      (await getCachedCategoryUpcomingSet(asListingDb(), kv, c, NOW)).map((e) => e.id);
    expect(await ids("Fair")).toEqual(["u1", "u2", "u8"]); // "Craft Fair" contains "Fair"; tie u1/u2 by id
    expect(await ids("Festival")).toEqual(["u3", "u8"]); // "FESTIVAL" matches (ASCII LIKE)
    expect(await ids("Farmers Market")).toEqual(["u4"]);
    const fair = await getCachedCategoryUpcomingSet(asListingDb(), kv, "Fair", NOW);
    expect(fair[0].vendors[0].displayName).toBe("Pottery!");
  });

  it("a KV hit equals the miss (Dates still Dates) and reads no D1", async () => {
    const { kv } = memoryKv();
    const miss = await getCachedCategoryUpcomingSet(asListingDb(), kv, "Fair", NOW);
    const spy = vi.spyOn(db, "select");
    const hit = await getCachedCategoryUpcomingSet(asListingDb(), kv, "Fair", NOW);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(hit).toEqual(miss);
    expect(hit[0].startDate).toBeInstanceOf(Date);
  });
});

describe("/events/past — cached id index vs the live paged read", () => {
  const KEYS: PastListingParams[] = [
    {},
    { state: "ME" },
    { state: "NH" },
    { state: "me" }, // venues.state = ? is case-sensitive: matches nothing
    { category: "craft" },
    { category: "Fair" },
    { state: "ME", category: "fair" },
  ];
  it.each(KEYS)("%j: every page and the total match", async (p) => {
    const { kv } = memoryKv();
    for (const page of [1, 2, 3, 4, 50]) {
      const opts = { limit: LIMIT, offset: (page - 1) * LIMIT, now: NOW };
      const live = await loadPastEventsLive(asListingDb(), p, opts);
      const cached = await loadPastEventsCached(asListingDb(), kv, p, opts);
      expect(cached).toEqual(live);
    }
  });

  it("is discriminating, ordered end-date desc with an id tiebreak (landmark)", async () => {
    const { kv } = memoryKv();
    expect(await getCachedPastIndex(asListingDb(), kv, {}, NOW)).toEqual([
      "q5",
      "q1",
      "q2",
      "q3",
      "q4",
      "q6",
    ]);
    // venue-less q3 has no venues.state, so a state filter drops it — as live does.
    expect(await getCachedPastIndex(asListingDb(), kv, { state: "ME" }, NOW)).toEqual([
      "q1",
      "q4",
      "q6",
    ]);
    expect(await getCachedPastIndex(asListingDb(), kv, { category: "craft" }, NOW)).toEqual(["q4"]);
    const page = await loadPastEventsCached(
      asListingDb(),
      kv,
      { category: "craft" },
      {
        limit: 30,
        offset: 0,
        now: NOW,
      }
    );
    expect(page.events[0].vendors[0].displayName).toBe("Pottery!");
    expect(page.events[0].eventDayDates).toHaveLength(2);
  });

  it("a warm page costs one id lookup, not the scan + count", async () => {
    const { kv } = memoryKv();
    await getCachedPastIndex(asListingDb(), kv, {}, NOW);
    const spy = vi.spyOn(db, "select");
    await loadPastEventsCached(asListingDb(), kv, {}, { limit: LIMIT, offset: 2, now: NOW });
    // projection-by-id + vendor batch + event_days attach — and no count(*).
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

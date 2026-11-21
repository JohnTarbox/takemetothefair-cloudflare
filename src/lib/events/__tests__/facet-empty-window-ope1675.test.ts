/**
 * OPE-1675 — OPE-470's empty-window content contract, proven at simulated dates.
 *
 * OPE-470 scope 3: relaxing the region depth gate to a rolling year "ships blank
 * directories" unless a page with nothing forward still says something true —
 * the region's season, "plus last season's list". The statement shipped in #995;
 * the list did not, and the zero state could not be observed live in November
 * because no region was at zero yet. So it is driven here instead, on a real
 * SQLite database built from the Drizzle schema, through the same query
 * functions the page calls:
 *
 *   1. January, a Maine region (downeast-acadia — OPE-586 extended the mesh to
 *      Maine after OPE-470 shipped, so whether Maine inherited the contract was
 *      the open question) and the Berkshires: listing empty, page still
 *      indexable, and the content branch has a season AND a list to render.
 *   2. The list draws from the gate's own window and facet: nothing older than
 *      12 months, nothing from another region, nothing non-public.
 *   3. Across a full simulated year, no date leaves a region INDEXABLE with an
 *      empty listing and nothing in the content branch — the acceptance
 *      criterion "no region page serves an indexable blank directory".
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema";
import { events, venues, promoters, eventVendors, vendors, eventDays } from "../../db/schema";
import {
  countFacetForIndexing,
  getFacetEvents,
  getFacetSeasonality,
  LAST_SEASON_LIMIT,
} from "../facet-query";
import { getCachedFacetSeasonality } from "../state-listing-cache";
import type { ReadThroughKv } from "../../kv-read-through";
import { isFacetIndexable, resolveFacet, facetDepthBasis } from "../facets";
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
const asFacetDb = () => db as unknown as Parameters<typeof getFacetEvents>[0];

const JAN = new Date("2027-01-15T12:00:00Z");

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

function ev(
  id: string,
  venueId: string,
  startIso: string,
  status = "APPROVED"
): typeof events.$inferInsert {
  const start = at(startIso);
  return {
    id,
    name: `Fair ${id}`,
    slug: unsafeSlug(`fair-${id}`),
    promoterId: "p1",
    status,
    lifecycleStatus: "SCHEDULED",
    startDate: start,
    endDate: start,
    categories: JSON.stringify(["Fair"]),
    venueId,
  } as typeof events.$inferInsert;
}

/** A summer-only region: `n` events June–August of `year`, one per ~week. */
function summer(prefix: string, venueId: string, year: number, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(year, 5, 1 + i * 7, 12));
    return ev(`${prefix}${year}-${i}`, venueId, d.toISOString().slice(0, 10));
  });
}

async function seed() {
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Promo",
    slug: unsafeSlug("promo"),
    userId: "u1",
  } as typeof promoters.$inferInsert);
  await db.insert(venues).values([
    {
      id: "v-bh",
      name: "Village Green",
      slug: unsafeSlug("vg"),
      address: "1 St",
      city: "Bar Harbor",
      state: "ME",
      zip: "04609",
    },
    {
      id: "v-port",
      name: "Portland Expo",
      slug: unsafeSlug("pe"),
      address: "2 St",
      city: "Portland",
      state: "ME",
      zip: "04101",
    },
    {
      id: "v-pitt",
      name: "The Common",
      slug: unsafeSlug("tc"),
      address: "3 St",
      city: "Pittsfield",
      state: "MA",
      zip: "01201",
    },
  ] as Array<typeof venues.$inferInsert>);

  await db.insert(events).values([
    // Down East & Acadia: 10 last summer — above the floor of 8, all in the past by January.
    ...summer("bh", "v-bh", 2026, 10),
    ev("bh-old", "v-bh", "2025-12-20"), // > 12 months before JAN: outside the window
    ev("bh-rej", "v-bh", "2026-07-04", "REJECTED"), // not public (incl. merge tombstones)
    ev("bh-pend", "v-bh", "2026-07-05", "PENDING"), // not public
    // Another Maine region — must not leak into Down East's list.
    ...summer("pt", "v-port", 2026, 3),
    // The Berkshires: 9 last summer.
    ...summer("pf", "v-pitt", 2026, 9),
  ]);
}

beforeEach(async () => {
  const raw = new Database(":memory:");
  for (const t of [promoters, venues, events, vendors, eventVendors, eventDays]) {
    raw.exec(ddlFor(t));
  }
  db = drizzle(raw, { schema });
  await seed();
});

const REGIONS = [
  { stateCode: "ME", stateSlug: "maine", facetSlug: "downeast-acadia", expected: 10 },
  { stateCode: "MA", stateSlug: "massachusetts", facetSlug: "berkshires", expected: 9 },
] as const;

async function renderState(r: (typeof REGIONS)[number], now: Date) {
  const facet = resolveFacet(r.stateSlug, r.facetSlug, now)!;
  const listing = await getFacetEvents(asFacetDb(), r.stateCode, r.stateSlug, facet, now, 1, 24);
  const depth = await countFacetForIndexing(asFacetDb(), r.stateCode, r.stateSlug, facet, now);
  const season = await getFacetSeasonality(asFacetDb(), r.stateCode, r.stateSlug, facet, now);
  return { facet, listing, depth, indexable: isFacetIndexable(facet, depth), season };
}

describe("January: a region with an empty forward window", () => {
  for (const r of REGIONS) {
    it(`${r.stateSlug}/${r.facetSlug} — empty list, still indexable, season + last season's list`, async () => {
      const { facet, listing, depth, indexable, season } = await renderState(r, JAN);
      expect(facet.kind).toBe("region");
      expect(facetDepthBasis(facet.kind)).toBe("rolling12");

      // The zero state is reached: nothing forward.
      expect(listing.total).toBe(0);
      // …and the page still asks to be indexed (the OPE-470 gate) —
      expect(depth).toBe(r.expected);
      expect(indexable).toBe(true);

      // — so the content branch MUST have something to say.
      expect(season.total).toBe(depth); // same window, same facet as the gate
      // Weekly from Jun 1: one August date (Aug 3) is under the 15% month threshold.
      expect(season.months).toEqual([6, 7]);
      expect(season.recent).toHaveLength(r.expected);
      // Newest first.
      const starts = season.recent.map((e) => e.startMs);
      expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    });
  }

  it("the list is the gate's own population: in-window, in-region, public only", async () => {
    const { season } = await renderState(REGIONS[0], JAN);
    const slugs = season.recent.map((e) => e.slug);
    expect(slugs.every((s) => s.startsWith("fair-bh2026-"))).toBe(true);
    expect(slugs).not.toContain("fair-bh-old");
    expect(slugs).not.toContain("fair-bh-rej");
    expect(slugs).not.toContain("fair-bh-pend");
    expect(slugs.some((s) => s.startsWith("fair-pt"))).toBe(false);
  });

  it("is capped at LAST_SEASON_LIMIT", async () => {
    await db.insert(events).values(summer("bx", "v-bh", 2026, 8)); // 18 in-window now
    const { season } = await renderState(REGIONS[0], JAN);
    expect(season.total).toBe(18);
    expect(season.recent).toHaveLength(LAST_SEASON_LIMIT);
  });

  it("survives the KV round-trip it is served through (startMs stays a number)", async () => {
    const store = new Map<string, string>();
    const kv: ReadThroughKv = {
      async get(k) {
        const v = store.get(k);
        return v === undefined ? null : JSON.parse(v);
      },
      async put(k, v) {
        store.set(k, v);
      },
    };
    const facet = resolveFacet("maine", "downeast-acadia", JAN)!;
    const miss = await getCachedFacetSeasonality(asFacetDb(), kv, "ME", "maine", facet, JAN);
    const hit = await getCachedFacetSeasonality(asFacetDb(), kv, "ME", "maine", facet, JAN);
    expect([...store.keys()].some((k) => k.endsWith(":season2"))).toBe(true);
    expect(hit).toEqual(miss);
    expect(typeof hit.recent[0].startMs).toBe("number");
  });
});

describe("no indexable blank directory at any simulated date across a year", () => {
  it("with next season NOT yet published, the empty-and-indexable state is reached and covered", async () => {
    // The realistic January: last summer listed, next summer's dates not out.
    const r = REGIONS[0];
    let reached = 0;
    for (let m = 0; m < 12; m++) {
      const now = new Date(Date.UTC(2026, 8 + m, 1, 12));
      const { listing, indexable, season } = await renderState(r, now);
      if (!indexable || listing.total > 0) continue;
      reached++;
      expect(season.total, now.toISOString()).toBeGreaterThan(0);
      expect(season.recent.length, now.toISOString()).toBeGreaterThan(0);
    }
    // Positive landmark (the loop must actually hit the branch it guards):
    // Sep 2026 → Jun 2027 are empty and indexable — 10 dates. On Jun 1 2027 the
    // window's lower bound is Jun 1 2026, inclusive, so all ten 2026 editions
    // still count; from Jul 1 five have left, depth 5 < 8, and the page goes
    // noindex rather than blank.
    expect(reached).toBe(10);
  });
});

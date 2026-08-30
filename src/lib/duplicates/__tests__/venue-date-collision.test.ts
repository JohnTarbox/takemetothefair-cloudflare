/**
 * OPE-627 — the (venue, calendar day) collision check.
 *
 * Fixtures are the REAL 2026-08-29 census: all four true duplicate pairs and
 * all six legitimate same-venue/same-day pairs, with their actual venue ids,
 * promoter ids and dates. A synthetic fixture would have let any of the
 * precision rules I tried look correct — every one of them dropped a true pair
 * or flagged a legitimate one against this data.
 *
 * The base rate is 4 true of 10 flagged. That is not a bug to tune away: a
 * large fairground legitimately hosts several events at once, so this is a
 * candidate generator. The acceptance says flagging the six is acceptable and
 * MERGING any of them is a failure, and the last block here is that guard.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";
import {
  findVenueDateCollisions,
  pickPrimaryCollision,
  detectPossibleDuplicate,
} from "../venue-date-collision";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'APPROVED',
    venue_id TEXT,
    promoter_id TEXT,
    start_date INTEGER,
    end_date INTEGER,
    merged_into TEXT,
    possible_duplicate_of TEXT
  );
`;

/** Noon UTC — the placeholder 72.6% of dated rows actually carry. */
const day = (iso: string) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);
const asDate = (iso: string) => new Date(`${iso}T12:00:00Z`);

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

interface Row {
  slug: string;
  name: string;
  venue: string;
  promoter: string;
  start: string;
  end: string;
  status?: string;
  merged?: string;
}

const CENSUS: Row[] = [
  // ── the four TRUE duplicate pairs ──────────────────────────────────────
  {
    slug: "new-england-home-show-rhode-island-2026",
    name: "New England Home Show Rhode Island 2026",
    venue: "f56bcd2a",
    promoter: "c9ff5eb5",
    start: "2026-03-27",
    end: "2026-03-29",
  },
  {
    slug: "new-england-home-show-lincoln-ri-2026",
    name: "New England Home Show Lincoln RI 2026",
    venue: "f56bcd2a",
    promoter: "488c86fd",
    start: "2026-03-27",
    end: "2026-03-29",
    status: "TENTATIVE",
  },

  {
    slug: "pttf-holiday-craft-fair-2026",
    name: "PTTF Holiday Craft Fair 2026",
    venue: "c46818fe",
    promoter: "aef3e095",
    start: "2026-11-21",
    end: "2026-11-21",
  },
  {
    slug: "thorntons-ferry-holiday-craft-fair-2026",
    name: "Thorntons Ferry Holiday Craft Fair 2026",
    venue: "c46818fe",
    promoter: "aef3e095",
    start: "2026-11-21",
    end: "2026-11-21",
    status: "TENTATIVE",
  },

  {
    slug: "scarborough-high-school-craft-show-2026",
    name: "Scarborough High School Craft Show 2026",
    venue: "904dfcf1",
    promoter: "system-community-suggestions",
    start: "2026-11-27",
    end: "2026-11-28",
    status: "TENTATIVE",
  },
  {
    slug: "ssmc-craft-show-scarborough-2026",
    name: "SSMC Craft Show Scarborough 2026",
    venue: "904dfcf1",
    promoter: "ed95ad28",
    start: "2026-11-27",
    end: "2026-11-28",
    status: "TENTATIVE",
  },

  {
    slug: "logging-festival-days-2026",
    name: "Logging Festival Days 2026",
    venue: "8b772fab",
    promoter: "system-community-suggestions",
    start: "2026-07-17",
    end: "2026-07-17",
  },
  {
    slug: "maine-forestry-museum-logging-festival",
    name: "Maine Forestry Museum Logging Festival",
    venue: "8b772fab",
    promoter: "24561097",
    start: "2026-07-17",
    end: "2026-07-18",
  },

  // ── the six LEGITIMATE pairs (flagging is acceptable, merging is not) ───
  {
    slug: "cape-cod-hydrangea-festival-2026",
    name: "Cape Cod Hydrangea Festival 2026",
    venue: "0c78e6f7",
    promoter: "d28faa5f",
    start: "2026-07-10",
    end: "2026-07-19",
  },
  {
    slug: "cape-cod-hydrangea-festival-kickoff-party-2026",
    name: "Cape Cod Hydrangea Festival Kickoff Party 2026",
    venue: "0c78e6f7",
    promoter: "system-community-suggestions",
    start: "2026-07-10",
    end: "2026-07-10",
  },

  {
    slug: "fiber-festival-of-new-england-2026",
    name: "Fiber Festival of New England 2026",
    venue: "a00e9108",
    promoter: "b4401fb2",
    start: "2026-11-07",
    end: "2026-11-08",
  },
  {
    slug: "old-deerfield-craft-fairs-holiday-sampler",
    name: "Old Deerfield Craft Fairs Holiday Sampler",
    venue: "a00e9108",
    promoter: "8a71b393",
    start: "2026-11-07",
    end: "2026-11-08",
  },

  // Exeter America-250: one town green, five real events. 1 pair on Jul 9,
  // 3 pairs on Jul 11. All but one share promoter 48fa8b58.
  {
    slug: "exeter-farmers-market-america-250-edition",
    name: "Exeter Farmer's Market — America 250 Edition",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-09",
    end: "2026-07-09",
  },
  {
    slug: "exeter-community-picnic-and-concert-america-250",
    name: "Exeter Community Picnic & Concert — America 250",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-09",
    end: "2026-07-09",
  },
  {
    slug: "american-independence-festival-2026",
    name: "American Independence Festival 2026",
    venue: "2e9e3af6",
    promoter: "256e82be",
    start: "2026-07-11",
    end: "2026-07-11",
  },
  {
    slug: "patriotic-all-wheels-youth-parade-exeter-250",
    name: "Patriotic All Wheels Youth Parade — Exeter 250",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-11",
    end: "2026-07-11",
  },
  {
    slug: "exeter-fireworks-america-250",
    name: "Exeter Fireworks — America 250",
    venue: "2e9e3af6",
    promoter: "48fa8b58",
    start: "2026-07-11",
    end: "2026-07-11",
  },
];

function seed(r: Row) {
  raw
    .prepare(
      `INSERT INTO events (id, name, slug, status, venue_id, promoter_id, start_date, end_date, merged_into)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      r.slug,
      r.name,
      r.slug,
      r.status ?? "APPROVED",
      r.venue,
      r.promoter,
      day(r.start),
      day(r.end),
      r.merged ?? null
    );
}

/** Detect against the census as if `row` were arriving now. */
const arriving = (r: Row) =>
  findVenueDateCollisions(db as never, {
    venueId: r.venue,
    startDate: asDate(r.start),
    endDate: asDate(r.end),
    name: r.name,
    promoterId: r.promoter,
    excludeEventId: r.slug,
  });

const bySlug = (s: string) => CENSUS.find((r) => r.slug === s)!;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  CENSUS.forEach(seed);
});

describe("catches all four true duplicate pairs", () => {
  const pairs: [string, string][] = [
    ["new-england-home-show-rhode-island-2026", "new-england-home-show-lincoln-ri-2026"],
    ["pttf-holiday-craft-fair-2026", "thorntons-ferry-holiday-craft-fair-2026"],
    ["scarborough-high-school-craft-show-2026", "ssmc-craft-show-scarborough-2026"],
    ["logging-festival-days-2026", "maine-forestry-museum-logging-festival"],
  ];

  for (const [a, b] of pairs) {
    it(`flags ${a} against ${b}`, async () => {
      const hits = await arriving(bySlug(a));
      expect(hits.map((h) => h.id)).toContain(b);
    });
  }

  it("covers the PTTF case specifically — the acceptance names it", async () => {
    // Same promoter, same venue, same date, submitted 45 days apart. It shares
    // ZERO distinctive name tokens with its twin ("pttf" vs "thorntons ferry"),
    // which is exactly why a name-similarity rule would have missed it.
    const hits = await arriving(bySlug("pttf-holiday-craft-fair-2026"));
    const twin = hits.find((h) => h.id === "thorntons-ferry-holiday-craft-fair-2026")!;
    expect(twin).toBeDefined();
    expect(twin.sharedDistinctive).toEqual([]);
    expect(twin.samePromoter).toBe(true);
  });

  it("catches the Logging Festival pair despite mismatched end dates", async () => {
    // Jul 17 vs Jul 17-18. A "end dates must match" rule would drop the very
    // pair this family was filed from (OPE-606).
    const hits = await arriving(bySlug("logging-festival-days-2026"));
    const twin = hits.find((h) => h.id === "maine-forestry-museum-logging-festival")!;
    expect(twin).toBeDefined();
    expect(twin.endDateDeltaDays).toBe(1);
  });
});

describe("the predicate is day-granular and venue-scoped", () => {
  it("does not collide across different days at the same venue", async () => {
    // The Exeter green holds events on Jun 29, Jun 30, Jul 6, 7, 9, 11.
    const hits = await arriving(bySlug("american-independence-festival-2026"));
    expect(hits.every((h) => h.id !== "exeter-farmers-market-america-250-edition")).toBe(true);
  });

  it("returns nothing when there is no venue or no start date", async () => {
    // Drafts and unresolved imports are legitimate; a detector that threw on
    // them would turn a check into an outage.
    expect(
      await findVenueDateCollisions(db as never, {
        venueId: null,
        startDate: asDate("2026-07-11"),
        name: "x",
      })
    ).toEqual([]);
    expect(
      await findVenueDateCollisions(db as never, {
        venueId: "2e9e3af6",
        startDate: null,
        name: "x",
      })
    ).toEqual([]);
  });

  it("never offers a merge tombstone", async () => {
    // A tombstone's slug 301s to its keeper (OPE-432), so returning one hands
    // the caller a URL that redirects away.
    raw
      .prepare(`UPDATE events SET merged_into='keeper' WHERE id=?`)
      .run("thorntons-ferry-holiday-craft-fair-2026");
    const hits = await arriving(bySlug("pttf-holiday-craft-fair-2026"));
    expect(hits.map((h) => h.id)).not.toContain("thorntons-ferry-holiday-craft-fair-2026");
  });
});

describe("ranking puts the strongest signal first", () => {
  it("prefers the same-promoter candidate over a name match", async () => {
    // On this census the same-promoter pair is the one with no name overlap at
    // all, so a name-first ranking would bury the strongest signal in the set.
    const hits = await arriving(bySlug("exeter-fireworks-america-250"));
    const primary = pickPrimaryCollision(hits)!;
    expect(primary.samePromoter).toBe(true);
  });

  it("returns null when there is nothing to rank", () => {
    expect(pickPrimaryCollision([])).toBeNull();
  });
});

describe("REPORT-ONLY — merging any of these is the failure mode", () => {
  it("writes no row at all: detection leaves the events table byte-identical", async () => {
    // The acceptance is explicit that flagging the six legitimate pairs is
    // acceptable and merging them is a fail. This asserts the stronger property:
    // the detector mutates NOTHING. The flag is written by the intake route,
    // once, on the row being created — never on an existing row.
    const before = raw
      .prepare(`SELECT id, status, merged_into, possible_duplicate_of FROM events ORDER BY id`)
      .all();

    for (const r of CENSUS)
      await detectPossibleDuplicate(db as never, {
        venueId: r.venue,
        startDate: asDate(r.start),
        endDate: asDate(r.end),
        name: r.name,
        promoterId: r.promoter,
        excludeEventId: r.slug,
      });

    const after = raw
      .prepare(`SELECT id, status, merged_into, possible_duplicate_of FROM events ORDER BY id`)
      .all();
    expect(after).toEqual(before);
    expect(after.every((r) => (r as { merged_into: string | null }).merged_into === null)).toBe(
      true
    );
  });

  it("documents the measured base rate rather than claiming precision", async () => {
    // 10 flagged pairs, 4 true. If a future change makes this number move, the
    // change is either an improvement worth stating or a regression worth
    // catching — either way it should not move silently.
    const flagged = new Set<string>();
    for (const r of CENSUS) {
      for (const h of await arriving(r)) {
        flagged.add([r.slug, h.id].sort().join("|"));
      }
    }
    expect(flagged.size).toBe(10);
  });
});

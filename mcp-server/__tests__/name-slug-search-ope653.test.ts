/**
 * OPE-653 — the same blindness OPE-647 fixed for vendors, on the sibling
 * surfaces: `search_venues`, `search_promoters`, `search_performers`, and
 * `search_events`' venue_name filter.
 *
 * Every string below is a REAL production name, read from prod D1 on
 * 2026-08-30, not an invented fixture. That matters, because the population
 * turned out not to be what the ticket assumed: of the 20 affected rows,
 * **18 were em/en-dashes**, one a curly apostrophe, and exactly ONE a real
 * accent. A fix folding only diacritics would have passed a hand-written
 * "café" test and missed 95% of the rows a person actually cannot find.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../src/schema.js";
import { venues, promoters, performers } from "../src/schema.js";
import { nameOrSlugContains, containsCI } from "../src/schema.js";

const SCHEMA_SQL = `
  CREATE TABLE venues (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    city TEXT, state TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE'
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY, company_name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE
  );
  CREATE TABLE performers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    deleted_at INTEGER
  );
`;

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Real prod rows: name → slug, exactly as stored. */
const PROD_VENUES: Array<[string, string, string]> = [
  ["Downtown Concord — Main Street", "downtown-concord-main-street", "Concord"],
  ["Bates Mill Complex – 2 Oxford Street", "bates-mill-complex-2-oxford-street", "Lewiston"],
  ["Wild Oats Bakery & Café", "wild-oats-bakery-and-cafe", "Brunswick"],
  [
    "Nantucket Wine & Food Festival — Multiple Venues",
    "nantucket-wine-food-festival-venues",
    "Nantucket",
  ],
  // An all-ASCII control. If a change makes everything match, this row alone
  // cannot reveal it — but it catches a change that breaks ordinary search.
  ["Cumberland County Fairgrounds", "cumberland-county-fairgrounds", "Cumberland"],
];

const PROD_PROMOTERS: Array<[string, string]> = [
  [
    "CHIRP — Concert Happenings in Ridgefield's Parks",
    "chirp-concert-happenings-in-ridgefields-parks",
  ],
  ["Northboro Junior Woman’s Club", "northboro-junior-womans-club"],
  ["Maine Fairs Association", "maine-fairs-association"],
];

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = drizzle(raw, { schema });
  PROD_VENUES.forEach(([name, slug, city], i) =>
    raw
      .prepare(`INSERT INTO venues (id,name,slug,city,state) VALUES (?,?,?,?,'ME')`)
      .run(`v${i}`, name, slug, city)
  );
  PROD_PROMOTERS.forEach(([name, slug], i) =>
    raw
      .prepare(`INSERT INTO promoters (id,company_name,slug) VALUES (?,?,?)`)
      .run(`p${i}`, name, slug)
  );
  // Prod has ZERO non-ASCII performer names (0 of 307 on 2026-08-30). Seeded
  // here anyway: the call site is identical to the other three, and the reason
  // to patch it is that it WILL be hit the first time someone harvests a band
  // with an accent — not that it is broken today.
  raw
    .prepare(
      `INSERT INTO performers (id,name,slug,deleted_at) VALUES ('pf1','Mr. Drew — Animals Too','mr-drew-animals-too',NULL)`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO performers (id,name,slug,deleted_at) VALUES ('pf2','Retired Act','retired-act',1700000000)`
    )
    .run();
});

const findVenues = (q: string) =>
  db
    .select({ name: venues.name })
    .from(venues)
    .where(nameOrSlugContains(q, venues.name, venues.slug))
    .all();
const findPromoters = (q: string) =>
  db
    .select({ name: promoters.companyName })
    .from(promoters)
    .where(nameOrSlugContains(q, promoters.companyName, promoters.slug))
    .all();

describe("OPE-653 — venues", () => {
  it("finds an em-dash name typed with an ordinary hyphen", () => {
    // What a person types. The stored name holds U+2014; the keyboard makes
    // U+002D. lower()/LIKE are ASCII-only, so these never meet on the name.
    const rows = findVenues("Downtown Concord - Main Street");
    expect(rows.map((r) => r.name)).toEqual(["Downtown Concord — Main Street"]);
  });

  it("finds an en-dash name typed with a hyphen", () => {
    const rows = findVenues("Bates Mill Complex - 2 Oxford");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain("Bates Mill");
  });

  it("finds the one genuinely accented row by its unaccented spelling", () => {
    expect(findVenues("cafe").map((r) => r.name)).toEqual(["Wild Oats Bakery & Café"]);
  });

  it("folds & to 'and' the way createSlug does", () => {
    // "Bakery and Cafe" cannot match the stored "Bakery & Café" on the name;
    // the slug stores the expanded, unaccented form, so the query slugifies
    // straight into it.
    expect(findVenues("Wild Oats Bakery and Cafe").map((r) => r.name)).toEqual([
      "Wild Oats Bakery & Café",
    ]);
  });

  it("does NOT reach a row whose stored slug diverges from its current name", () => {
    // An honest limitation, not a bug in the predicate — encoded so it is not
    // rediscovered as a surprise. The bridge works because `slug` is the
    // folded form OF THE NAME. Two of the 20 affected prod rows have slugs
    // that createSlug would not produce from the name they now carry:
    //
    //   "Nantucket Wine & Food Festival — Multiple Venues"
    //     createSlug(name) = nantucket-wine-and-food-festival-multiple-venues
    //     stored slug      = nantucket-wine-food-festival-venues
    //
    // Words were dropped ("and", "Multiple"), so the folded query is not a
    // substring. Measured 2026-08-30: 18 of 20 reachable by full-name search.
    // Both stragglers are still reachable by any PARTIAL query, which is what
    // a person actually types.
    expect(findVenues("Nantucket Wine and Food Festival - Multiple Venues")).toHaveLength(0);
    expect(findVenues("Nantucket Wine").map((r) => r.name)).toEqual([
      "Nantucket Wine & Food Festival — Multiple Venues",
    ]);
  });

  it("still matches a plain ASCII name on the name column", () => {
    expect(findVenues("Cumberland County").map((r) => r.name)).toEqual([
      "Cumberland County Fairgrounds",
    ]);
  });

  it("does not turn a punctuation-only query into 'return everything'", () => {
    // THE guard. createSlug("!!!") === "", and SQLite's instr(x, '') returns 1,
    // so an unguarded slug clause is `1 > 0` — true for every row. A nonsense
    // query must return nothing, not the whole table.
    expect(findVenues("!!!")).toHaveLength(0);
    expect(findVenues("---")).toHaveLength(0);
  });

  it("composes with the city filter rather than replacing it", () => {
    // Regression guard named in the acceptance: the slug clause is OR'd
    // internally but must stay AND'd against the other conditions.
    const rows = db
      .select({ name: venues.name })
      .from(venues)
      .where(
        and(
          nameOrSlugContains("Downtown Concord - Main Street", venues.name, venues.slug),
          containsCI(venues.city, "Lewiston")
        )
      )
      .all();
    expect(rows).toHaveLength(0);
  });

  it("composes with the ACTIVE status filter", () => {
    raw.prepare(`UPDATE venues SET status='INACTIVE' WHERE id='v0'`).run();
    const rows = db
      .select({ name: venues.name })
      .from(venues)
      .where(
        and(
          eq(venues.status, "ACTIVE"),
          nameOrSlugContains("Downtown Concord - Main Street", venues.name, venues.slug)
        )
      )
      .all();
    expect(rows).toHaveLength(0);
  });
});

describe("OPE-653 — promoters", () => {
  it("finds a curly-apostrophe name typed with a straight apostrophe", () => {
    const rows = findPromoters("Woman's Club");
    expect(rows.map((r) => r.name)).toEqual(["Northboro Junior Woman’s Club"]);
  });

  it("finds an em-dash promoter typed with a hyphen", () => {
    const rows = findPromoters("CHIRP - Concert Happenings");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain("CHIRP");
  });

  it("leaves an all-ASCII promoter search working", () => {
    expect(findPromoters("Maine Fairs").map((r) => r.name)).toEqual(["Maine Fairs Association"]);
  });
});

describe("OPE-653 — performers", () => {
  it("finds an em-dash performer typed with a hyphen", () => {
    const rows = db
      .select({ name: performers.name })
      .from(performers)
      .where(nameOrSlugContains("Mr. Drew - Animals", performers.name, performers.slug))
      .all();
    expect(rows.map((r) => r.name)).toEqual(["Mr. Drew — Animals Too"]);
  });

  it("composes with include_deleted rather than overriding it", () => {
    // Regression guard named in the acceptance.
    const live = db
      .select({ name: performers.name })
      .from(performers)
      .where(
        and(
          nameOrSlugContains("retired act", performers.name, performers.slug),
          isNull(performers.deletedAt)
        )
      )
      .all();
    expect(live).toHaveLength(0);

    const all = db
      .select({ name: performers.name })
      .from(performers)
      .where(nameOrSlugContains("retired act", performers.name, performers.slug))
      .all();
    expect(all.map((r) => r.name)).toEqual(["Retired Act"]);
  });
});

describe("OPE-653 — the emitted SQL", () => {
  it("omits the slug branch entirely when the query slugifies to nothing", () => {
    // Not merely 'returns no extra rows': the clause must not be EMITTED, or a
    // future reader will see an empty branch and assume it is dead code.
    const withSlug = db
      .select()
      .from(venues)
      .where(nameOrSlugContains("concord", venues.name, venues.slug))
      .toSQL().sql;
    const withoutSlug = db
      .select()
      .from(venues)
      .where(nameOrSlugContains("!!!", venues.name, venues.slug))
      .toSQL().sql;
    expect(withSlug).toContain(" or ");
    expect(withoutSlug).not.toContain(" or ");
  });

  it("is identical to a bare containsCI when slug-folding adds nothing", () => {
    const folded = db
      .select()
      .from(venues)
      .where(nameOrSlugContains("!!!", venues.name, venues.slug))
      .toSQL();
    const bare = db.select().from(venues).where(containsCI(venues.name, "!!!")).toSQL();
    expect(folded.sql).toBe(bare.sql);
  });
});

describe("OPE-653 — all four call sites route through the shared helper", () => {
  it("has no remaining name-only search predicate on the four surfaces", async () => {
    // Anchored on the CALL syntax with its column pair, not on the bare symbol
    // name — a bare-identifier search also matches the import line and goes
    // vacuously green.
    const fs = await import("node:fs/promises");
    const pub = await fs.readFile(new URL("../src/tools/public.ts", import.meta.url), "utf8");
    const perf = await fs.readFile(
      new URL("../src/tools/admin-performers.ts", import.meta.url),
      "utf8"
    );
    expect(pub).toContain("nameOrSlugContains(params.query, venues.name, venues.slug)");
    expect(pub).toContain("nameOrSlugContains(params.venue_name, venues.name, venues.slug)");
    expect(pub).toContain(
      "nameOrSlugContains(params.query, promoters.companyName, promoters.slug)"
    );
    expect(perf).toContain("nameOrSlugContains(params.query, performers.name, performers.slug)");
    // And the defective forms are gone.
    expect(pub).not.toContain("containsCI(venues.name, params.query)");
    expect(pub).not.toContain("containsCI(venues.name, params.venue_name)");
    expect(pub).not.toContain("containsCI(promoters.companyName, params.query)");
    expect(perf).not.toContain("containsCI(performers.name, params.query)");
  });
});

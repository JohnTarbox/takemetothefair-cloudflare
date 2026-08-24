/**
 * OPE-541 / OPE-531 — minting a venue from ingest prose.
 *
 * The ticket's specimen (`25c9c493`, "Crafters Care Events - Fall Fest 2026")
 * stored `venue_id = NULL` while its own description named "Doody's Totoket Inn
 * Restaurant, 465 Foxon Rd, North Branford, CT 06471". `autoLinkVenue` matches
 * only — it contains no `insert(venues)` — so a venue we have never seen cannot
 * resolve, by construction. Minting is the only fix, and OPE-541's deliverable
 * 4 asks what stops it producing near-duplicate venue rows.
 *
 * These tests ARE that answer. Each one kills a specific mutation of a guard,
 * because a guard nobody tests is a comment. They run against a real in-memory
 * sqlite carrying the two constraints that matter — `slug NOT NULL UNIQUE` —
 * so the collision and race paths are exercised rather than described.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { mintVenueFromIngest, SLUG_ATTEMPTS } from "../venue-minting";

/**
 * The FULL venue shape, not just the columns under test: drizzle's
 * better-sqlite3 insert names every column of the table and lets SQL supply
 * the defaults, so a partial CREATE TABLE fails with "no column named
 * location_id" rather than with anything about what is being tested.
 *
 * `slug NOT NULL UNIQUE` is the constraint that makes the collision and race
 * cases real instead of narrated.
 */
const SCHEMA_SQL = `
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip TEXT NOT NULL,
    location_id TEXT,
    location_matched_by TEXT,
    location_match_km REAL,
    latitude REAL,
    longitude REAL,
    capacity INTEGER,
    amenities TEXT DEFAULT '[]',
    contact_email TEXT,
    contact_phone TEXT,
    website TEXT,
    description TEXT,
    image_url TEXT,
    google_place_id TEXT,
    google_maps_url TEXT,
    opening_hours TEXT,
    google_rating REAL,
    google_rating_count INTEGER,
    google_types TEXT,
    accessibility TEXT,
    parking TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    locale TEXT NOT NULL DEFAULT 'en-US',
    country TEXT NOT NULL DEFAULT 'US',
    created_at INTEGER,
    updated_at INTEGER,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5
  );
  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

/** The specimen, as the extractor would hand it over. */
const DOODYS = {
  decision: "no-match",
  venueName: "Doody's Totoket Inn Restaurant",
  venueAddress: "465 Foxon Rd",
  venueCity: "North Branford",
  venueState: "CT",
};

function seedVenue(
  id: string,
  name: string,
  slug: string,
  opts: { city?: string; state?: string } = {}
) {
  raw
    .prepare(
      `INSERT INTO venues (id, name, slug, address, city, state, zip)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, name, slug, "", opts.city ?? "North Branford", opts.state ?? "CT", "");
}

const countVenues = () =>
  (raw.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number }).n;

describe("the specimen mints", () => {
  it("creates the venue that autoLinkVenue could never have found", async () => {
    const r = await mintVenueFromIngest(db, DOODYS);
    expect(r.minted).toBe(true);
    expect(r.venueId).toBeTruthy();

    const row = raw.prepare("SELECT * FROM venues").get() as Record<string, unknown>;
    expect(row.name).toBe("Doody's Totoket Inn Restaurant");
    expect(row.city).toBe("North Branford");
    expect(row.state).toBe("CT");
    expect(row.address).toBe("465 Foxon Rd");
    expect(row.status).toBe("ACTIVE");
  });

  it("slugs through createSlug, not a hand-rolled chain", async () => {
    // The #120 divergence in one assertion: `&` becomes "and" and the
    // apostrophe drops cleanly. A naive `/[^a-z0-9]+/g` chain yields
    // `doody-s-totoket-inn-restaurant` and mints a silent duplicate of a row
    // the canonical generator would have matched.
    const r = await mintVenueFromIngest(db, {
      ...DOODYS,
      venueName: "Doody's Totoket Inn & Restaurant",
    });
    expect(r.slug).toBe("doodys-totoket-inn-and-restaurant");
  });

  it("uppercases the state so the re-check and the column agree", async () => {
    await mintVenueFromIngest(db, { ...DOODYS, venueState: "ct" });
    const row = raw.prepare("SELECT state FROM venues").get() as { state: string };
    expect(row.state).toBe("CT");
  });
});

describe("guard 1 — only on no-match", () => {
  it.each(["ambiguous", "no-name", "exact-name+state", "fuzzy-name+state", "pre-resolved"])(
    "refuses to mint on %s",
    async (decision) => {
      const r = await mintVenueFromIngest(db, { ...DOODYS, decision });
      expect(r.minted).toBe(false);
      expect(r.reason).toBe("decision-not-no-match");
      expect(countVenues()).toBe(0);
    }
  );

  it("refusing on `ambiguous` is the point, not an accident", async () => {
    // `ambiguous` means the matcher FOUND several candidates and could not
    // choose. Minting there adds a third row to a set we were already unsure
    // about — the exact shape OPE-473 spent a ticket consolidating.
    seedVenue("v1", "Totoket Inn", "totoket-inn");
    seedVenue("v2", "Totoket Inn Restaurant", "totoket-inn-restaurant");
    const r = await mintVenueFromIngest(db, { ...DOODYS, decision: "ambiguous" });
    expect(r.minted).toBe(false);
    expect(countVenues()).toBe(2);
  });
});

describe("guard 2 — name AND city AND state", () => {
  it.each([
    ["no city", { venueCity: null }],
    ["no state", { venueState: null }],
    ["blank city", { venueCity: "   " }],
    ["blank state", { venueState: "" }],
  ])("refuses with %s", async (_label, patch) => {
    const r = await mintVenueFromIngest(db, { ...DOODYS, ...patch });
    expect(r.reason).toBe("missing-city-or-state");
    expect(countVenues()).toBe(0);
  });

  it("still mints without an address or zip — those are established practice", async () => {
    // 169 prod venues have an empty address and 183 an empty zip. Requiring
    // them would refuse most of what ingest can legitimately mint, and
    // INVENTING one is the OPE-537 failure.
    const r = await mintVenueFromIngest(db, { ...DOODYS, venueAddress: null });
    expect(r.minted).toBe(true);
    const row = raw.prepare("SELECT address, zip FROM venues").get() as Record<string, string>;
    expect(row.address).toBe("");
    expect(row.zip).toBe("");
  });

  it("refuses a missing name before anything else", async () => {
    const r = await mintVenueFromIngest(db, { ...DOODYS, venueName: "  " });
    expect(r.reason).toBe("missing-name");
  });
});

describe("guard 3 — the name has to be a venue name", () => {
  it.each(["TBD", "tba", "N/A", "Various", "  Unknown  ", "Just a moment...", "ONLINE"])(
    "refuses %s",
    async (venueName) => {
      const r = await mintVenueFromIngest(db, { ...DOODYS, venueName });
      expect(r.reason).toBe("name-not-a-venue");
      expect(countVenues()).toBe(0);
    }
  );

  it("refuses a name too short to be one", async () => {
    const r = await mintVenueFromIngest(db, { ...DOODYS, venueName: "Hi" });
    expect(r.reason).toBe("name-too-short");
  });

  it("does NOT refuse real places whose names contain a denied word", async () => {
    // The denylist is exact-match-after-normalizing on purpose. A substring
    // rule refuses these three, all plausible real venues, and the cost of a
    // false refusal here is a null venue an operator can fix — while a false
    // ACCEPT is a permanent junk row other events then match against.
    for (const venueName of ["Various Arts Center", "Online Academy Hall", "Nathan Hale Inn"]) {
      const r = await mintVenueFromIngest(db, { ...DOODYS, venueName });
      expect(r.minted, venueName).toBe(true);
    }
  });

  it("refuses a name with no slug rather than claiming the empty one", async () => {
    // createSlug("!!!") === "". The column is NOT NULL UNIQUE, so the first
    // such row would take "" and every later one would collide with it
    // forever — N rows fighting over one slug.
    const r = await mintVenueFromIngest(db, { ...DOODYS, venueName: "!!!" });
    expect(r.reason).toBe("unsluggable-name");
    expect(countVenues()).toBe(0);
  });
});

describe("guard 4 — the pre-insert re-check", () => {
  it("links to a row the matcher missed instead of minting a twin", async () => {
    // autoLinkVenue pulls candidates by LIKE on the first token and caps at
    // 100 rows, so it can return no-match with the exact row sitting in the
    // table. That is a LINK, not a refusal — the id must reach the caller.
    seedVenue("existing", "Doody's Totoket Inn Restaurant", "doodys-totoket-inn-restaurant");
    const r = await mintVenueFromIngest(db, DOODYS);
    expect(r.minted).toBe(false);
    expect(r.reason).toBe("matched-on-recheck");
    expect(r.venueId).toBe("existing");
    expect(countVenues()).toBe(1);
  });

  it("matches across case, quotes and whitespace", async () => {
    seedVenue("existing", "  DOODY’S  TOTOKET   INN RESTAURANT ", "d-t-i-r");
    const r = await mintVenueFromIngest(db, {
      ...DOODYS,
      venueName: "doody’s totoket inn restaurant",
    });
    expect(r.venueId).toBe("existing");
    expect(countVenues()).toBe(1);
  });

  it("does not link a same-named venue in a DIFFERENT state", async () => {
    // Two "Riverside Park"s in two states are two places. Linking them puts
    // an event on the wrong city page AND hands findDuplicate's venue_date
    // stage a false anchor, so the error propagates into dedup.
    seedVenue("ma-row", "Riverside Park", "riverside-park", { state: "MA", city: "Agawam" });
    const r = await mintVenueFromIngest(db, {
      ...DOODYS,
      venueName: "Riverside Park",
      venueCity: "Hartford",
      venueState: "CT",
    });
    expect(r.minted).toBe(true);
    expect(r.venueId).not.toBe("ma-row");
    expect(countVenues()).toBe(2);
  });
});

describe("normalization agrees on both sides", () => {
  // The regression that made this its own describe: the input was
  // quote-stripped in JS and the column was not, so `LOWER(TRIM(name))`
  // compared `doody's…` against `doodys…` and never matched. The guard was
  // inert for every name with an apostrophe — including the specimen's —
  // and inert in the minting direction, so it left no trace.
  //
  // Driven through the real query rather than by exporting the helpers: what
  // has to agree is SQL and JS, and only a round trip can show that.
  it.each([
    ["straight apostrophe", "Doody's Totoket Inn", "Doody's Totoket Inn"],
    ["curly vs straight", "Doody\u2019s Totoket Inn", "Doody's Totoket Inn"],
    ["straight vs curly", "Doody's Totoket Inn", "Doody\u2019s Totoket Inn"],
    ["double quotes", 'The "Old" Grange', "The Old Grange"],
    ["backtick", "O`Briens Hall", "OBriens Hall"],
    ["case", "TOTOKET INN", "totoket inn"],
    ["surrounding space", "  Totoket Inn  ", "Totoket Inn"],
    ["internal runs", "Totoket    Inn", "Totoket Inn"],
    ["tab", "Totoket\tInn", "Totoket Inn"],
  ])("links %s", async (_label, stored, submitted) => {
    seedVenue("existing", stored, "seeded-slug");
    const r = await mintVenueFromIngest(db, { ...DOODYS, venueName: submitted });
    expect(r.venueId).toBe("existing");
    expect(countVenues()).toBe(1);
  });

  it("still tells genuinely different names apart", async () => {
    // The normalizer folds punctuation and spacing, NOT words. If it ever
    // starts matching on a prefix or on squashed-out spaces, these link and
    // the event lands on the wrong venue.
    seedVenue("existing", "Totoket Inn", "totoket-inn");
    for (const venueName of ["Totoket Inn Restaurant", "Totoketinn", "Totoket Lodge"]) {
      const r = await mintVenueFromIngest(db, { ...DOODYS, venueName });
      expect(r.minted, venueName).toBe(true);
    }
  });
});

describe("guard 5 — slug collisions", () => {
  it("suffixes past a taken base slug", async () => {
    seedVenue("other", "Some Other Place", "doodys-totoket-inn-restaurant", { state: "RI" });
    const r = await mintVenueFromIngest(db, DOODYS);
    expect(r.minted).toBe(true);
    expect(r.slug).toBe("doodys-totoket-inn-restaurant-2");
  });

  it("checks the candidate it is about to USE, not the one before it", async () => {
    // The off-by-one this guards: a check-then-assign loop verifies `base`,
    // assigns `base-2`, verifies `base-2`, assigns `base-3` … and on its final
    // pass assigns a candidate it never checks. With both `base` and `base-2`
    // taken, that shape hands `base-2` to the insert and hits the UNIQUE index.
    seedVenue("a", "A", "doodys-totoket-inn-restaurant", { state: "RI" });
    seedVenue("b", "B", "doodys-totoket-inn-restaurant-2", { state: "RI" });
    const r = await mintVenueFromIngest(db, DOODYS);
    expect(r.slug).toBe("doodys-totoket-inn-restaurant-3");

    const stored = raw.prepare("SELECT slug FROM venues WHERE id = ?").get(r.venueId) as {
      slug: string;
    };
    expect(stored.slug).toBe("doodys-totoket-inn-restaurant-3");
  });

  it("gives up rather than colliding when every candidate is taken", async () => {
    seedVenue("base", "B", "doodys-totoket-inn-restaurant", { state: "RI" });
    for (let i = 2; i <= SLUG_ATTEMPTS; i++) {
      seedVenue(`s${i}`, `S${i}`, `doodys-totoket-inn-restaurant-${i}`, { state: "RI" });
    }
    const r = await mintVenueFromIngest(db, DOODYS);
    expect(r.reason).toBe("slug-exhausted");
    expect(r.venueId).toBeNull();
  });
});

describe("the check and the write are not atomic", () => {
  it("loses the UNIQUE race by linking, not by throwing", async () => {
    // Both the re-check and the slug scan are read-then-write, so two
    // submissions naming the same new venue can pass them together. Without
    // minting at all, this event would have saved with venue_id NULL — so a
    // throw here would be a 500 caused by an improvement.
    const realInsert = db.insert.bind(db);
    let raced = false;
    db.insert = (table: unknown) => {
      if (!raced) {
        raced = true;
        // The other request commits first, taking both the name and the slug.
        seedVenue("winner", "Doody's Totoket Inn Restaurant", "doodys-totoket-inn-restaurant");
      }
      return realInsert(table);
    };

    const r = await mintVenueFromIngest(db, DOODYS);
    expect(r.reason).toBe("matched-on-recheck");
    expect(r.venueId).toBe("winner");
    expect(countVenues()).toBe(1);
  });
});

describe("guard 6 — the minted cohort stays identifiable", () => {
  it("writes an admin_actions row naming the ingest path", async () => {
    // Without a named actor the row is anonymous, which OPE-433's specimen
    // showed is barely better than no audit at all: it records that something
    // happened and still cannot say what. This cohort has to be reversible.
    const r = await mintVenueFromIngest(db, DOODYS);
    const audit = raw
      .prepare("SELECT * FROM admin_actions WHERE target_id = ?")
      .get(r.venueId) as Record<string, string>;
    expect(audit).toBeTruthy();
    expect(audit.action).toBe("venue.create");
    expect(audit.target_type).toBe("venue");
    expect(JSON.parse(audit.payload_json).actor).toBe("email-ingest");
  });

  it("records no audit row for a refusal — nothing happened", async () => {
    await mintVenueFromIngest(db, { ...DOODYS, venueName: "TBD" });
    const n = (raw.prepare("SELECT COUNT(*) AS n FROM admin_actions").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

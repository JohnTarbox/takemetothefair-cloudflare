/**
 * OPE-739 — `NH` and `New Hampshire` are the same organisation and the dedup
 * could not tell.
 *
 * Nine such pairs exist in prod. SEVEN of the long-form rows carry `deleted_at`
 * inside a single 41-second window (1782618950–1782618991), which is what a
 * person cleaning duplicates by hand looks like in the data — and nothing in the
 * code changed afterwards, so the generator kept running. Two pairs are live:
 *
 *   NH Trappers Association   / New Hampshire Trappers Association
 *   NH Bear Hunters Assoc.    / New Hampshire Bear Hunters Assoc.
 *
 * ## What this is NOT
 *
 * OPE-739 was filed claiming this needed the narrowing fix too, because `nh` is
 * not a substring of `new hampshire`. **That was wrong, and reading
 * `rawNameStem` settles it.** Since OPE-715 both stems take the LONGEST safe
 * token, and for these names that is `association` — shared by both spellings.
 * The candidate was always fetched; only the score was short. So this is a
 * one-sided change to normalization, and the tests below prove the narrowing
 * carries it rather than assuming so.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import { createSlug, normalizeVendorName, US_STATE_ABBREVIATION_MAP } from "@takemetothefair/utils";
import { findFuzzyMatch, findStrictMatch } from "@takemetothefair/vendor-linking";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY, business_name TEXT NOT NULL, slug TEXT,
    vendor_type TEXT, redirect_to_vendor_id TEXT, deleted_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(id: string, name: string, type: string | null = null) {
  raw
    .prepare(`INSERT INTO vendors (id, business_name, slug, vendor_type) VALUES (?,?,?,?)`)
    .run(id, name, createSlug(name) as string, type);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the two pairs that are duplicated in prod right now", () => {
  it("NH Trappers Association finds the stored New Hampshire Trappers Association", async () => {
    seed("stored", "New Hampshire Trappers Association", "Nonprofit");
    expect((await findStrictMatch(db, "NH Trappers Association"))?.id).toBe("stored");
  });

  it("and the other direction — the spelled-out name finds the stored NH row", async () => {
    // Both directions matter. OPE-712's `&`/`and` defect was ASYMMETRIC and that
    // is exactly why it hid for a month, so neither direction is assumed here.
    seed("stored", "NH Trappers Association", "Nonprofit");
    expect((await findStrictMatch(db, "New Hampshire Trappers Association"))?.id).toBe("stored");
  });

  it("NH Bear Hunters Assoc. finds New Hampshire Bear Hunters Assoc.", async () => {
    // Also exercises the abbreviation map in the same name (`assoc`).
    seed("stored", "New Hampshire Bear Hunters Assoc.", "Nonprofit");
    expect((await findStrictMatch(db, "NH Bear Hunters Assoc."))?.id).toBe("stored");
  });

  it("fuzzy matching agrees with strict, and is not carried by the type", async () => {
    // Type is deliberately DIFFERENT — OPE-451 removed it from the comparison
    // string, and a test that let the types agree could not tell whether the
    // name change or the type did the work.
    seed("stored", "New Hampshire Off Highway Vehicle Association", "Nonprofit");
    expect((await findFuzzyMatch(db, "NH Off Highway Vehicle Association", "Club"))?.row.id).toBe(
      "stored"
    );
  });
});

describe("the narrowing still reaches the candidate — verified, not assumed", () => {
  it("survives a flood at the real prod population of `association` rows", async () => {
    // The stem for both spellings is `association`, the longest safe token. If
    // that were ever changed back to a first-token rule the stem becomes `nh`,
    // `LIKE '%nh%'` misses "New Hampshire…" entirely, and this fails — which is
    // the regression this test exists to catch.
    //
    // 56 is not an arbitrary flood size: it is the measured count of live
    // vendors containing "association" on 2026-09-01, against a
    // FUZZY_CANDIDATE_CAP of 200. The target is seeded LAST so it sits at the
    // far end of the scan, which is where OPE-715's version of this test went
    // vacuously green by seeding it first.
    for (let i = 0; i < 56; i++) seed(`noise-${i}`, `Barnstable Association ${i}`);
    seed("target", "New Hampshire Trappers Association", "Nonprofit");
    expect((await findStrictMatch(db, "NH Trappers Association"))?.id).toBe("target");
  });

  it("is bounded by the SHARED 200-row cap, not by anything this fix introduced", async () => {
    // Characterising a real limit rather than hiding it. Past 200 rows sharing a
    // stem, the narrowing fetches an arbitrary 200 and the true match can fall
    // outside — the OPE-715 mechanism, which applies to every stem and not just
    // this one.
    //
    // Headroom today: 56 of 6,805 live vendors contain "association", so the
    // stem is 3.5x under the cap. Pinned so that if "association" ever crosses
    // 200 this test starts failing and names the reason, instead of the NH pairs
    // quietly beginning to duplicate again.
    for (let i = 0; i < 260; i++) seed(`noise-${i}`, `Barnstable Association ${i}`);
    seed("target", "New Hampshire Trappers Association", "Nonprofit");
    expect(await findStrictMatch(db, "NH Trappers Association")).toBeNull();
  });
});

describe("`me` is the pronoun, and nine live vendors depend on it staying one", () => {
  it.each([
    "The Sea by Me",
    "Waffle Me",
    "Love Rocks Me",
    "Knot Me Knot You",
    "Picture Me 3D",
    "Magic Me Vacations",
    "Dottie And Me Designs",
  ])("does not rewrite %s into Maine", (name) => {
    expect(normalizeVendorName(name)).not.toContain("maine");
  });

  it("`me` is absent from the map, and its absence is the safety property", () => {
    // Pinned as an assertion rather than left to the comment. Adding `me` would
    // silently rewrite nine live vendor names and could produce a WRONG merge,
    // and `merge_vendor` has no inverse.
    expect(US_STATE_ABBREVIATION_MAP).not.toHaveProperty("me");
  });

  it("only measured codes are present at all", () => {
    // vt/ct/ma/ri/ny measured ZERO colliding pairs on 2026-09-01. Adding them
    // would be a fix for nothing — the thing OPE-723 was filed to avoid.
    expect(Object.keys(US_STATE_ABBREVIATION_MAP)).toEqual(["nh"]);
  });
});

describe("the expansion is token-wise and the threshold is not loosened", () => {
  it("does not rewrite a word that merely starts with nh", () => {
    expect(normalizeVendorName("NHRA Racing Collectibles")).toBe("nhra racing collectibles");
    expect(normalizeVendorName("Enhance Salon")).toBe("enhance salon");
  });

  it("expands nh where it stands alone mid-name", () => {
    expect(normalizeVendorName("League of NH Craftsmen")).toBe("league of new hampshire craftsmen");
  });

  it("does NOT match two different NH organisations to each other", async () => {
    // The control the ticket asked for. If the gate had loosened into a word
    // match, "association" plus a shared state would be enough to merge two
    // unrelated clubs.
    seed("guides", "NH Guide Association", "Nonprofit");
    expect(await findFuzzyMatch(db, "NH Trappers Association", "Nonprofit")).toBeNull();
  });

  it("does NOT match NH to a different state's version of the same club", async () => {
    seed("vt", "Vermont Trappers Association", "Nonprofit");
    expect(await findFuzzyMatch(db, "NH Trappers Association", "Nonprofit")).toBeNull();
  });
});

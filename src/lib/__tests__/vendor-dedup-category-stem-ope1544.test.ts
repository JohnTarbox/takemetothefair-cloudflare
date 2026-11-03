/**
 * OPE-1544 — the longest token was "brewing", and "brewing" is a category.
 *
 * A Mass Craft Brewers roster pass on 2026-10-30 (fuzzy, the default) minted a
 * duplicate of six existing breweries — including "Tree House Brewing", whose
 * stored name was BYTE-IDENTICAL. Measured on prod the same morning:
 *
 *   live vendors whose business_name contains "brewing" ... 350 (of 13,070)
 *   FUZZY_CANDIDATE_CAP .................................... 200
 *   existing Tree House / Castle Island / True West /
 *     Night Shift rows inside that 200 ..................... 0
 *
 * `rawNameStem` takes the LONGEST safe token, so every "<X> <Y> Brewing" name
 * stemmed on "brewing" and the true row never reached the scorer. Names whose
 * own words were longer ("Arlington", "Aeronaut") matched in the same run.
 * OPE-715 was this shape with "the".
 *
 * Two fixes, each driven to failure below:
 *  1. `fuzzy` checks for an exact (case-insensitive) name before narrowing.
 *  2. A ranked multi-token pass, so a row sharing several incoming tokens
 *     outranks the rows sharing only the category word.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import { createSlug } from "@takemetothefair/utils";
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

/**
 * Prod has 350 "brewing" rows against a 200 cap. Inserted FIRST, so the target
 * lands beyond the cap in rowid order — seeding it first would put it inside
 * every LIMIT and the test would pass against the unfixed code (the OPE-715
 * lesson). Names avoid every token of the targets below.
 */
function floodWithBrewing(n: number) {
  for (let i = 0; i < n; i++) seed(`noise-${i}`, `Zymurgy${i} Brewing`, "Brewery");
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("a byte-identical name links regardless of the narrowing", () => {
  it("finds Tree House Brewing through a flooded candidate space", async () => {
    floodWithBrewing(350);
    seed("a8d4357a", "Tree House Brewing", null);

    const hit = await findFuzzyMatch(db, "Tree House Brewing", "Brewery");
    expect(hit?.row.id).toBe("a8d4357a");
    expect(hit?.score).toBe(1);
  });

  it("finds a ONE-word name whose only token is the flooded category", async () => {
    // The case only the exact pass can catch: one token, so the ranked pass
    // never runs, and its stem is the flooded word. Mutating the exact pass
    // away left every other test here green — this is the one that goes red.
    floodWithBrewing(350);
    seed("solo", "Brewing");
    expect((await findFuzzyMatch(db, "Brewing", "Brewery"))?.row.id).toBe("solo");
  });

  it("links the LOWEST id when the name is already duplicated", async () => {
    floodWithBrewing(350);
    seed("b-second", "Tree House Brewing");
    seed("a-first", "Tree House Brewing");
    expect((await findFuzzyMatch(db, "tree house brewing", null))?.row.id).toBe("a-first");
  });

  it("ignores a soft-deleted exact name", async () => {
    seed("gone", "Tree House Brewing");
    raw.prepare(`UPDATE vendors SET deleted_at = 1 WHERE id = 'gone'`).run();
    expect(await findFuzzyMatch(db, "Tree House Brewing", null)).toBeNull();
  });
});

describe("X Brewing Co. matches X Brewing through the same flood", () => {
  it.each([
    ["Castle Island Brewing Co.", "Castle Island Brewing"],
    ["True West Brewing Co.", "True West Brewing"],
    // The control: stems on its own word, matched in the live run too.
    ["Aeronaut Brewing Co.", "Aeronaut Brewing"],
  ])("fuzzy: %s → %s", async (incoming, stored) => {
    floodWithBrewing(350);
    seed("target", stored, null);
    expect((await findFuzzyMatch(db, incoming, "Brewery"))?.row.id).toBe("target");
  });

  it("strict: Castle Island Brewing Co. → Castle Island Brewing", async () => {
    floodWithBrewing(350);
    seed("target", "Castle Island Brewing");
    expect((await findStrictMatch(db, "Castle Island Brewing Co."))?.id).toBe("target");
  });
});

describe("the ranked pass widens recall, not the match", () => {
  it("still refuses a different brewery that shares only the category word", async () => {
    seed("other", "Night Shift Brewing");
    expect(await findFuzzyMatch(db, "Tree House Brewing", "Brewery")).toBeNull();
  });
});

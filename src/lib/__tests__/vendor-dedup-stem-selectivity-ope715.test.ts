/**
 * OPE-715 — the stem was "the", and "the" is not a stem.
 *
 * 322 clusters / 727 live rows share a byte-identical `business_name`. 720 of
 * those rows predate OPE-451 (2026-08-17), which removed `vendorType` from the
 * dedup comparison string and closed the original cause.
 *
 * SEVEN were minted after it. Every single one begins with "The ":
 *
 *   The Knotty Cod - The Sea by Me (x3) - The Savage Light (x2)
 *   The Wine Slushie Guy
 *
 * The mechanism is `selectStemCandidates`, which took the FIRST token of >= 3
 * characters — "the" for every one of them. Measured against prod 2026-09-01:
 *
 *   vendors whose business_name contains "the" ....... 439
 *   vendors whose slug contains "the" ................ 439
 *   FUZZY_CANDIDATE_CAP .............................. 200
 *   live vendors starting with "The " ................ 176
 *
 * So the narrowing fetched an arbitrary 200 of 439 and the true match was
 * crowded out about half the time. OPE-712's slug clause did NOT save it: that
 * picks the longest token, and for "the-sea-by-me" the longest is still "the".
 *
 * The rule underneath the fix: a stem is a RAW-TEXT filter while equality is
 * judged on the NORMALIZED string, so a token normalization can add or remove —
 * or that is simply too common — is a stem that can delete the row it should
 * find.
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

/** Flood the candidate space with rows containing "the", as prod does (439). */
function floodWithThe(n: number) {
  for (let i = 0; i < n; i++) seed(`noise-${i}`, `Another Thelma Bakery ${i}`);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the four real vendors that were duplicated after the previous fix", () => {
  it.each([
    ["The Sea by Me", "Mixed Media", "Art & Photography"],
    ["The Savage Light", "Candles", "Candles, Stone"],
    ["The Wine Slushie Guy", "Specialty Foods", "Specialty Foods"],
    ["The Knotty Cod", null, "Seafood"],
  ])("finds %s through a flooded candidate space", async (name, storedType, incomingType) => {
    // ORDER IS THE WHOLE TEST. The flood is inserted FIRST so the target lands
    // beyond the 200-row cap in rowid order; seeding the target first puts it at
    // rowid 1, inside every LIMIT, and the test passes against the unfixed code.
    // It did exactly that on the first attempt — the mutation caught it.
    floodWithThe(250);
    seed("target", name, storedType);

    const hit = await findFuzzyMatch(db, name, incomingType);
    expect(hit?.row.id).toBe("target");
  });

  it("strict matching survives the same flood", async () => {
    floodWithThe(250);
    seed("target", "The Sea by Me");
    expect((await findStrictMatch(db, "The Sea by Me"))?.id).toBe("target");
  });
});

describe("the stem must stay normalization-stable", () => {
  it("still folds a trailing legal form — Co. vs Company", async () => {
    // The regression the first version of this fix introduced. Preferring the
    // LONGEST token made "Center Street Soap Company" stem on "company", which
    // cannot match the stored "Center Street Soap Co." — the two differ by
    // exactly the token being searched for. Legal forms are normalization-
    // UNSTABLE (normalize strips them) and are excluded from stem candidacy.
    seed("soap", "Center Street Soap Co.");
    expect((await findStrictMatch(db, "Center Street Soap Company"))?.id).toBe("soap");
  });

  it("still folds & against and (OPE-712)", async () => {
    seed("md", "M & D Fine Jewelry", "Jewelry");
    expect((await findFuzzyMatch(db, "M and D Fine Jewelry", "Jewelry"))?.row.id).toBe("md");
  });

  it("handles a name made ENTIRELY of unsafe tokens", async () => {
    // "The Company" — every token is either low-selectivity or a legal form. The
    // selector must still narrow on something rather than returning undefined
    // and scanning the cap unfiltered.
    seed("tc", "The Company");
    expect((await findStrictMatch(db, "The Company"))?.id).toBe("tc");
  });
});

describe("the threshold is not loosened", () => {
  it("still refuses two different businesses that share a word", async () => {
    // A more selective stem must not become a looser match. If this passes
    // something through, the >= 0.92 gate has been lost.
    seed("p1", "Portland Pottery Studio", "Maker");
    expect(await findFuzzyMatch(db, "Portland Cider Company", "Food")).toBeNull();
  });

  it("does not match two different 'The' businesses to each other", async () => {
    seed("a", "The Savage Light", "Candles");
    expect(await findFuzzyMatch(db, "The Sea by Me", "Mixed Media")).toBeNull();
  });
});

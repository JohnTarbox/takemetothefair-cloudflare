/**
 * OPE-712 — the dedup miss that happens BEFORE scoring.
 *
 * The ticket reported that `fuzzy` "scores the raw string and does not fold
 * ampersands", producing a ~0.75 near-miss under the 0.92 gate. Measured at
 * source, that is not what happens: `getVendorComparisonString` runs
 * `normalizeVendorName`, which expands `&` to "and", so both spellings
 * normalize to "m and d fine jewelry" and score exactly **1.0**.
 *
 * The candidate is deleted before the scorer ever sees it. `selectStemCandidates`
 * narrows with `LIKE '%<stem>%'` against the RAW `business_name`, and the stem is
 * the first token of ≥3 characters — which for "M and D Fine Jewelry" is the word
 * **"and"**. "M & D Fine Jewelry" contains no "and", so it is not fetched.
 *
 * That distinction decides the fix. A scoring bug is fixed in the normalizer; a
 * narrowing bug is fixed in the query, and no amount of testing the normalizer
 * would ever have found it — which is why the repo's existing dedup tests are
 * green and the duplicate still got minted (prod, 2026-08-31).
 *
 * These run against real SQLite, following `vendor-dedup-ope451.test.ts`: the
 * defect lives in the SQL, so a mocked db would assert the fix exists rather
 * than that it works.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import { createSlug } from "@takemetothefair/utils";
import { findFuzzyMatch, findStrictMatch } from "@takemetothefair/vendor-linking";

const SCHEMA_SQL = `
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    slug TEXT,
    vendor_type TEXT,
    redirect_to_vendor_id TEXT,
    deleted_at INTEGER
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

/** Slug is written by `createSlug` at insert time, exactly as production does. */
function seed(id: string, businessName: string, vendorType: string | null = null) {
  raw
    .prepare(`INSERT INTO vendors (id, business_name, slug, vendor_type) VALUES (?,?,?,?)`)
    .run(id, businessName, createSlug(businessName) as string, vendorType);
}

/** A row whose slug was deliberately left divergent from its name (a rename). */
function seedWithSlug(id: string, businessName: string, slug: string) {
  raw
    .prepare(`INSERT INTO vendors (id, business_name, slug, vendor_type) VALUES (?,?,?,?)`)
    .run(id, businessName, slug, null);
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("the ampersand spelling must not delete the candidate before scoring", () => {
  it("matches the prod instance: 'M and D Fine Jewelry' finds 'M & D Fine Jewelry'", async () => {
    // ada25b48… created 2026-07-27; the duplicate 1c36debf… was minted
    // 2026-08-31T16:24:50Z and has since been merged away.
    seed("ada25b48", "M & D Fine Jewelry", "Jewelry");

    const hit = await findFuzzyMatch(db, "M and D Fine Jewelry", "Jewelry");

    expect(hit?.row.id).toBe("ada25b48");
    // 1.0, not 0.75 — the normalizer was never the problem.
    expect(hit?.score).toBe(1);
  });

  it("matches the same shape with a two-initial name ('B & B Crafts')", async () => {
    // Same root cause, second instance: the ampersand follows a token too short
    // to be a stem, so "and" wins the stem slot.
    seed("bb01", "B & B Crafts");
    expect((await findFuzzyMatch(db, "B and B Crafts", null))?.row.id).toBe("bb01");
  });

  it("still matches the direction that always worked (asymmetry is why this hid)", async () => {
    // Control. "M & D Fine Jewelry" stems on "fine" and has ALWAYS matched.
    // If this ever fails, the fix broke the working half.
    seed("md02", "M and D Fine Jewelry");
    expect((await findFuzzyMatch(db, "M & D Fine Jewelry", null))?.row.id).toBe("md02");
  });

  it("reaches `strict` too, which shares the same narrowing", async () => {
    // Both strategies call `selectStemCandidates`, so the candidate deletion hit
    // both. `strict` is the fallback callers are told to use when `fuzzy`
    // misbehaves (OPE-451), so it failing the same way removes the escape hatch.
    seed("st01", "M & D Fine Jewelry", "Jewelry");
    expect((await findStrictMatch(db, "M and D Fine Jewelry"))?.id).toBe("st01");
  });

  it("was unaffected when the ampersand follows a long token ('Lemon & Maisey')", async () => {
    // Control for the ticket's own evidence: 189 later ampersand writes in the
    // same run produced no duplicates. They stem on "lemon", not "and" — so
    // they were never in scope, and their success was not evidence the rule
    // had been fixed.
    seed("lm03", "Lemon & Maisey");
    expect((await findFuzzyMatch(db, "Lemon and Maisey", null))?.row.id).toBe("lm03");
  });
});

describe("the narrowing must stay a narrowing", () => {
  it("does not match two different businesses that merely share a slug token", async () => {
    // The slug clause widens the candidate set; the ≥0.92 gate still decides.
    // If this passes something through, the fix has turned dedup into a word match.
    seed("p1", "Portland Pottery Studio", "Maker");
    expect(await findFuzzyMatch(db, "Portland Cider Company", "Food")).toBeNull();
  });

  it("still finds a row whose slug has drifted from its renamed business_name", async () => {
    // Slugs are SEO-stable and deliberately survive a rename, so the slug clause
    // must SUPPLEMENT the name clause rather than replace it. This row is
    // reachable only through the name clause.
    seedWithSlug("drift1", "Riverbend Alpaca Farm", "old-marketing-name-2019");
    expect((await findFuzzyMatch(db, "Riverbend Alpaca Farm", null))?.row.id).toBe("drift1");
  });

  it("excludes soft-deleted merge tombstones from both narrowing passes", async () => {
    // The added slug query is a second WHERE clause and could easily have
    // omitted the deleted_at guard, silently re-linking merge tombstones.
    seed("tomb1", "M & D Fine Jewelry", "Jewelry");
    raw.prepare(`UPDATE vendors SET deleted_at = 1788193761 WHERE id = 'tomb1'`).run();
    expect(await findFuzzyMatch(db, "M and D Fine Jewelry", "Jewelry")).toBeNull();
  });
});

describe("non-vacuity", () => {
  it("confirms the corpus is real and the raw-name stem genuinely misses it", async () => {
    // Guards against the whole file passing for the wrong reason. Asserts the
    // PRECONDITION of the defect directly: the pre-fix narrowing could not have
    // found this row, so a green result above must come from the new clause.
    seed("ada25b48", "M & D Fine Jewelry", "Jewelry");

    const stem = "M and D Fine Jewelry"
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 3)[0];
    expect(stem).toBe("and");

    const rowsMatchedByOldNarrowing = raw
      .prepare(`SELECT COUNT(*) AS n FROM vendors WHERE business_name LIKE ?`)
      .get(`%${stem}%`) as { n: number };
    expect(rowsMatchedByOldNarrowing.n).toBe(0);

    // …while the row is present and reachable in the slug space.
    const total = raw.prepare(`SELECT COUNT(*) AS n FROM vendors`).get() as { n: number };
    expect(total.n).toBe(1);
    expect(createSlug("M & D Fine Jewelry") as string).toBe(
      createSlug("M and D Fine Jewelry") as string
    );
  });
});

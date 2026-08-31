/**
 * OPE-713 — the producer-class denominator, made runnable from outside the route.
 *
 * A roster pass on 2026-08-31 added 530 vendor links and took 11 events to a
 * terminal status. `producerClass.coveragePct` moved **0.4pp**, and the two
 * largest rosters it completed were invisible to it. The ticket inferred from
 * the outcomes that `event_scale` gated membership — a LARGE show counted while
 * two null-scale shows did not.
 *
 * Scale is not in the predicate at all. Membership keys on `categories`, and the
 * rows involved (read from prod) settle it:
 *
 *   Memorial Day … Mill Falls 2026   ["Craft Fair","Festival"]                counted
 *   Kill Tide Arts & Craft Festival  []                                       not
 *   Nauset Summer Craft Festival     []                                       not
 *   Great Falls Balloon Festival     ["Festival","Community Event"]           not
 *   Quechee Scottish Games           ["Festival","Cultural Festival",...]     not
 *
 * The wrong inference was reasonable: nothing outside the route could run the
 * rule, so the only available evidence was which writes happened to count. That
 * is why the predicate is now extracted and tested here — the same remedy
 * `vendorSearchWhere` got in OPE-632/OPE-566.
 *
 * These run against real SQLite because the defect class lives in SQL NULL
 * semantics, which no pure-function test reproduces.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@takemetothefair/db-schema";
import {
  pastProducerClassWhere,
  pastNonProducerClassWhere,
  hasNoCategories,
  producerClassCond,
} from "@takemetothefair/db-schema";
import { PRODUCER_CLASS_CATEGORIES } from "@takemetothefair/constants";
import { events } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

const SCHEMA_SQL = `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    categories TEXT,
    lifecycle_status TEXT,
    vendor_roster_status TEXT,
    merged_into TEXT
  );
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let raw: InstanceType<typeof Database>;

function seed(
  id: string,
  name: string,
  categories: string | null,
  lifecycle = "OCCURRED",
  rosterStatus: string | null = "HAS_ROSTER",
  mergedInto: string | null = null
) {
  raw
    .prepare(
      `INSERT INTO events (id, name, categories, lifecycle_status, vendor_roster_status, merged_into)
       VALUES (?,?,?,?,?,?)`
    )
    .run(id, name, categories, lifecycle, rosterStatus, mergedInto);
}

/** The four real rows the drain completed that the metric could not see. */
function seedTheInvisibleFour() {
  seed("kill-tide", "Kill Tide Arts & Craft Festival 2026", "[]");
  seed("nauset", "Nauset Summer Craft Festival 2026", "[]");
  seed("great-falls", "Great Falls Balloon Festival 2026", '["Festival","Community Event"]');
  seed(
    "quechee",
    "Quechee Scottish Games & Festival 2026",
    '["Festival","Cultural Festival","Community Event"]'
  );
}

async function idsMatching(where: ReturnType<typeof pastProducerClassWhere>): Promise<string[]> {
  const rows = await db.select({ id: events.id }).from(events).where(where);
  return rows.map((r: { id: string }) => r.id).sort();
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

describe("membership keys on categories, not scale", () => {
  it("counts the Castleberry show that carries 'Craft Fair'", async () => {
    seed(
      "mill-falls",
      "Memorial Day Weekend Craft Festival at Mill Falls 2026",
      '["Craft Fair","Festival"]'
    );
    seedTheInvisibleFour();

    expect(await idsMatching(pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([
      "mill-falls",
    ]);
  });

  it("excludes all four the drain completed, for two different reasons", async () => {
    seedTheInvisibleFour();

    expect(await idsMatching(pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([]);
    expect(await idsMatching(pastNonProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([
      "great-falls",
      "kill-tide",
      "nauset",
      "quechee",
    ]);
  });

  it("'Craft Festival' is not a producer-class category — widening cannot reach the empty ones", async () => {
    // The names all say "Craft Festival". The category vocabulary has
    // "Craft Fair" and "Craft Show" and no "Craft Festival", so a reader
    // matching on the NAME would conclude these should count. They carry no
    // categories at all, which is a data gap, not a vocabulary gap.
    expect(PRODUCER_CLASS_CATEGORIES).not.toContain("Craft Festival");
    expect(PRODUCER_CLASS_CATEGORIES).toContain("Craft Fair");
  });
});

describe("the negated predicate must not lose uncategorised rows", () => {
  it("returns a row whose categories column is NULL", async () => {
    // THE load-bearing case. `NULL LIKE '%x%'` is NULL, so an un-COALESCEd
    // `NOT (...)` is also NULL and the row fails the filter — silently dropping
    // exactly the population this query exists to count. Same trap as
    // `isNonResearchCategory`, which carries the same guard for the same reason.
    seed("null-cats", "Uncategorised Fair 2026", null);

    expect(await idsMatching(pastNonProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([
      "null-cats",
    ]);
  });

  it("proves the guard is load-bearing: without COALESCE the NULL row disappears", async () => {
    // Runs the un-guarded form directly. If this ever returns the row, SQLite's
    // NULL semantics have changed and the guard above could be simplified —
    // until then, this is why it cannot be.
    seed("null-cats", "Uncategorised Fair 2026", null);

    const unguarded = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`NOT (${events.categories} LIKE '%"Craft Fair"%')`);

    expect(unguarded).toEqual([]);
  });

  it("counts empty-array and NULL alike as 'no categories'", async () => {
    seed("empty", "Empty Array 2026", "[]");
    seed("nullc", "Null Column 2026", null);
    seed("has", "Has Categories 2026", '["Festival"]');

    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${hasNoCategories()}`);
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual(["empty", "nullc"]);
  });
});

describe("the frame around the predicate", () => {
  it("excludes merge tombstones from both sides", async () => {
    seed(
      "tomb-p",
      "Tombstoned Craft Fair 2026",
      '["Craft Fair"]',
      "OCCURRED",
      "HAS_ROSTER",
      "keeper"
    );
    seed("tomb-n", "Tombstoned Festival 2026", '["Festival"]', "OCCURRED", "HAS_ROSTER", "keeper");

    expect(await idsMatching(pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([]);
    expect(await idsMatching(pastNonProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([]);
  });

  it("excludes events that have not OCCURRED from both sides", async () => {
    seed("upcoming-p", "Future Craft Fair 2027", '["Craft Fair"]', "TENTATIVE");
    seed("upcoming-n", "Future Festival 2027", '["Festival"]', "TENTATIVE");

    expect(await idsMatching(pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([]);
    expect(await idsMatching(pastNonProducerClassWhere(PRODUCER_CLASS_CATEGORIES))).toEqual([]);
  });

  it("partitions cleanly: every past OCCURRED row lands in exactly one side", async () => {
    // The two blocks are reported as siblings and read as a partition. If they
    // ever overlap or leak, `allPastOccurred` double-counts or under-counts.
    seed("a", "A Craft Fair 2026", '["Craft Fair"]');
    seed("b", "B Festival 2026", '["Festival"]');
    seed("c", "C Nothing 2026", null);
    seed("d", "D Empty 2026", "[]");

    const inClass = await idsMatching(pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES));
    const outClass = await idsMatching(pastNonProducerClassWhere(PRODUCER_CLASS_CATEGORIES));

    expect(inClass).toEqual(["a"]);
    expect(outClass).toEqual(["b", "c", "d"]);
    expect([...inClass, ...outClass].sort()).toEqual(["a", "b", "c", "d"]);
    expect(inClass.filter((id) => outClass.includes(id))).toEqual([]);
  });
});

describe("non-vacuity", () => {
  it("the predicate actually discriminates — it is neither always-true nor always-false", async () => {
    // A predicate that matched everything, or nothing, would satisfy several
    // assertions above by accident. This pins that it does neither.
    seed("yes", "Yes Craft Fair 2026", '["Craft Fair"]');
    seed("no", "No Festival 2026", '["Festival"]');

    const matched = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${producerClassCond(PRODUCER_CLASS_CATEGORIES)}`);
    expect(matched.map((r: { id: string }) => r.id)).toEqual(["yes"]);

    const total = raw.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    expect(total.n).toBe(2);
  });

  it("every producer-class category is matchable, so none is a dead entry", async () => {
    // Guards a typo in the vocabulary: a category value that no row can ever
    // carry would silently shrink the denominator forever.
    for (const [i, category] of PRODUCER_CLASS_CATEGORIES.entries()) {
      seed(`cat-${i}`, `Event ${i}`, JSON.stringify([category]));
    }
    const matched = await idsMatching(pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES));
    expect(matched).toHaveLength(PRODUCER_CLASS_CATEGORIES.length);
  });
});

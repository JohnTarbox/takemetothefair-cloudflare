/**
 * OPE-528 — the roster queue counted rows no drain could ever close.
 *
 * Measured in prod 2026-08-24, `vendor_roster_status='NEEDS_RESEARCH'`:
 *
 *     520  APPROVED, not a tombstone      <- the real queue
 *     128  ...of which weekly farmers markets
 *       8  REJECTED, not a tombstone
 *       3  REJECTED merge tombstones      <- the whole unexplained 547-vs-544 gap
 *     ---
 *     531
 *
 * The drain sorts `end_date_desc`, so the un-closeable rows were not merely
 * inflating a total — they were the first thing every pass read.
 *
 * These run the REAL shared predicate as SQL against real rows. Both the MCP
 * queue filter and the main app's coverage totals import this same function, so
 * pinning it here pins both.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, inArray, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { rosterResearchTargetWhere, isNonResearchCategory } from "@takemetothefair/db-schema";
import { events } from "../src/schema.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

let seq = 0;
async function ev(over: Partial<typeof events.$inferInsert> = {}) {
  seq += 1;
  await db.insert(events).values({
    id: `ev-${seq}`,
    name: `Event ${seq}`,
    slug: `event-${seq}` as never,
    promoterId: "p-1",
    status: "APPROVED",
    vendorRosterStatus: "NEEDS_RESEARCH",
    ...over,
  } as typeof events.$inferInsert);
}

async function targets(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(events)
    .where(
      and(rosterResearchTargetWhere(), inArray(events.vendorRosterStatus, ["NEEDS_RESEARCH"]))
    );
  return rows[0]?.n ?? 0;
}

describe("what stays in the queue", () => {
  it("keeps an ordinary APPROVED craft fair", async () => {
    await ev({ name: "Kingfield Craft Fair", categories: '["Craft Fair"]' });
    expect(await targets()).toBe(1);
  });

  it("keeps an event with no categories at all", async () => {
    // Absent categories must not be read as a non-research class — that would
    // silently empty the queue of everything unclassified.
    await ev({ categories: null });
    expect(await targets()).toBe(1);
  });
});

describe("what the queue drops", () => {
  it("drops a weekly farmers-market occurrence", async () => {
    await ev({
      name: "Rutland Downtown Summer Farmers Market — 2026-08-22",
      categories: '["Farmers Market"]',
    });
    expect(await targets()).toBe(0);
  });

  it("drops it whatever case the category is stored in", async () => {
    await ev({ categories: '["farmers market"]' });
    await ev({ categories: '["FARMERS MARKET"]' });
    expect(await targets()).toBe(0);
  });

  it("drops a market even when it carries other categories too", async () => {
    await ev({ categories: '["Community Event","Farmers Market"]' });
    expect(await targets()).toBe(0);
  });

  it("drops a REJECTED event — the decision is already taken", async () => {
    await ev({ status: "REJECTED", categories: '["Craft Fair"]' });
    expect(await targets()).toBe(0);
  });

  it("drops every non-APPROVED status, not just REJECTED", async () => {
    for (const status of ["REJECTED", "PENDING", "CANCELLED", "DRAFT"]) {
      await ev({ status, categories: '["Craft Fair"]' });
    }
    expect(await targets()).toBe(0);
  });

  it("drops a merge tombstone — this is the entire 3-row gap", async () => {
    // The coverage route filtered `merged_into IS NULL`; list_all_events did
    // not. One definition now, so they cannot differ again.
    await ev({ mergedInto: "ev-keeper", status: "REJECTED", categories: '["Craft Fair"]' });
    expect(await targets()).toBe(0);
  });

  it("drops an APPROVED tombstone, which the status clause cannot catch", async () => {
    // Written after a mutation check: removing the `merged_into` clause left
    // every test above still passing, because the tombstone fixture is ALSO
    // REJECTED and the status clause was doing the work. A test that passes
    // with the clause deleted is not testing the clause.
    //
    // Not a hypothetical shape either — OPE-423 found a half-completed merge
    // that left BOTH rows APPROVED and indexable, `merged_into` set on a live
    // page. That is exactly this row.
    await ev({ mergedInto: "ev-keeper", status: "APPROVED", categories: '["Craft Fair"]' });
    expect(await targets()).toBe(0);
  });
});

describe("the prod population, reproduced", () => {
  it("reduces 531 rows of the measured shape to the 520-minus-markets target set", async () => {
    // 520 APPROVED (128 of them markets) + 8 REJECTED + 3 tombstones.
    for (let i = 0; i < 392; i++) await ev({ categories: '["Craft Fair"]' });
    for (let i = 0; i < 128; i++) await ev({ categories: '["Farmers Market"]' });
    for (let i = 0; i < 8; i++) await ev({ status: "REJECTED", categories: '["Craft Fair"]' });
    for (let i = 0; i < 3; i++)
      await ev({ status: "REJECTED", mergedInto: "ev-keeper", categories: '["Craft Fair"]' });

    const all = await db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(inArray(events.vendorRosterStatus, ["NEEDS_RESEARCH"]));
    expect(all[0].n).toBe(531);
    expect(await targets()).toBe(392);
  });
});

describe("isNonResearchCategory in isolation", () => {
  it("matches only the named classes", async () => {
    await ev({ categories: '["Craft Fair"]' });
    await ev({ categories: '["Farmers Market"]' });
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(isNonResearchCategory());
    expect(rows[0].n).toBe(1);
  });
});

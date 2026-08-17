/**
 * OPE-414 — market-player register.
 *
 * The two behaviours worth pinning are the ones that would corrupt the register
 * silently rather than loudly:
 *
 *   1. Upsert must be idempotent on a NORMALIZED domain. If `visitmaine.com`
 *      and `https://VisitMaine.com/` produce two rows, the monthly sweep starts
 *      splitting one site's history across two identities and no error is ever
 *      raised.
 *   2. Upsert must not blank fields the caller omitted. A sweep that re-checks
 *      `has_schema` would otherwise erase an `owner` somebody researched by
 *      hand — data loss disguised as an update.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { marketPlayers, marketPlayerSnapshots, marketPlayerSerpRanks } from "../src/schema.js";
import { eq } from "drizzle-orm";
import { normalizeDomain } from "../src/tools/admin-market-players.js";

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

describe("normalizeDomain", () => {
  it("collapses the spellings the same site arrives as", () => {
    for (const raw of [
      "visitmaine.com",
      "VisitMaine.com",
      "https://visitmaine.com",
      "https://www.visitmaine.com/events",
      "  http://WWW.VisitMaine.com/  ",
      "visitmaine.com.",
    ]) {
      expect(normalizeDomain(raw), raw).toBe("visitmaine.com");
    }
  });

  it("keeps distinct hosts distinct", () => {
    expect(normalizeDomain("events.visitmaine.com")).toBe("events.visitmaine.com");
    expect(normalizeDomain("visitnh.gov")).toBe("visitnh.gov");
  });
});

describe("register storage", () => {
  async function seed(domain: string, over: Record<string, unknown> = {}) {
    const now = new Date("2026-08-17T00:00:00Z");
    await db.insert(marketPlayers).values({
      id: `id-${domain}`,
      domain,
      createdAt: now,
      updatedAt: now,
      ...over,
    });
  }

  it("upsert on domain updates in place instead of duplicating", async () => {
    await seed("thecraftmap.com", { name: "The Craft Map", relationship: "competitor" });
    const now = new Date("2026-09-01T00:00:00Z");
    await db
      .insert(marketPlayers)
      .values({
        id: "would-be-new",
        domain: "thecraftmap.com",
        createdAt: now,
        updatedAt: now,
        threatLevel: "medium",
      })
      .onConflictDoUpdate({
        target: marketPlayers.domain,
        set: { threatLevel: "medium", updatedAt: now },
      });

    const rows = await db.select().from(marketPlayers);
    expect(rows).toHaveLength(1);
    expect(rows[0].threatLevel).toBe("medium");
    // The hand-researched field survived the sweep.
    expect(rows[0].name).toBe("The Craft Map");
    expect(rows[0].relationship).toBe("competitor");
  });

  it("relationship and org_class are independent axes", async () => {
    // The case the table is named for: a government body that lists our events
    // is a citation source, never a competitor.
    await seed("visitmaine.com", { relationship: "citation_source", orgClass: "government" });
    await seed("thecraftmap.com", { relationship: "competitor", orgClass: "for_profit" });
    // …and the combination that proves they are not the same question.
    await seed("downtownbangor.com", { relationship: "partner", orgClass: "nonprofit" });

    const competitors = await db
      .select()
      .from(marketPlayers)
      .where(eq(marketPlayers.relationship, "competitor"));
    expect(competitors.map((r) => r.domain)).toEqual(["thecraftmap.com"]);

    const government = await db
      .select()
      .from(marketPlayers)
      .where(eq(marketPlayers.orgClass, "government"));
    expect(government.map((r) => r.domain)).toEqual(["visitmaine.com"]);
  });

  it("defaults keep an unclassified row out of the competitor set", async () => {
    // A row added in a hurry must not silently read as a threat.
    await seed("unknown-site.com");
    const [row] = await db.select().from(marketPlayers);
    expect(row.relationship).toBe("neutral");
    expect(row.orgClass).toBe("unknown");
    expect(row.threatLevel).toBeNull();
  });

  it("snapshots accumulate rather than overwrite — the trend is the product", async () => {
    await seed("thecraftmap.com");
    for (const [i, count] of [1200, 1310, 1290].entries()) {
      await db.insert(marketPlayerSnapshots).values({
        id: `snap-${i}`,
        playerId: "id-thecraftmap.com",
        eventCount: count,
        snapshotAt: new Date(Date.UTC(2026, 5 + i, 1)),
        createdAt: new Date(),
      });
    }
    const rows = await db
      .select()
      .from(marketPlayerSnapshots)
      .orderBy(marketPlayerSnapshots.snapshotAt);
    expect(rows.map((r) => r.eventCount)).toEqual([1200, 1310, 1290]);
  });

  it("a NULL metric records 'not countable', distinct from zero", async () => {
    await seed("craftfairlist.com");
    await db.insert(marketPlayerSnapshots).values({
      id: "snap-null",
      playerId: "id-craftfairlist.com",
      eventCount: null,
      notes: "listing page is JS-rendered; not countable this visit",
      snapshotAt: new Date(),
      createdAt: new Date(),
    });
    const [row] = await db.select().from(marketPlayerSnapshots);
    expect(row.eventCount).toBeNull();
    expect(row.eventCount).not.toBe(0);
  });

  it("a SERP row with NULL position means 'looked, not in range' — not 'never checked'", async () => {
    await seed("thecraftmap.com");
    await db.insert(marketPlayerSerpRanks).values({
      id: "rank-1",
      playerId: "id-thecraftmap.com",
      query: "craft fairs in Bangor",
      market: "Bangor, ME",
      position: null,
      checkedAt: new Date(),
      createdAt: new Date(),
    });
    const rows = await db.select().from(marketPlayerSerpRanks);
    // The row EXISTS (we checked) and position is NULL (they did not rank).
    // "Never checked" is the absence of a row entirely.
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBeNull();
    expect(rows[0].query).toBe("craft fairs in Bangor");
  });
});

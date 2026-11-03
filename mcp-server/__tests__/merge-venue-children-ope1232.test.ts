/**
 * OPE-1232 — merge_venue moved only events.venue_id; series hubs, periods,
 * name variants, claim citations and the loser's old redirects stayed on the
 * tombstone (10 series hubs in prod on 2026-10-01). Driven through the real
 * tool against SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { unsafeSlug } from "@takemetothefair/utils";
import { CapturingMcpServer, createTestDb, mockIndexNowFetch, type TestDb } from "./setup-db.js";
import { registerMergeEntitiesTools } from "../src/tools/admin-merge-entities.js";
import {
  eventSeries,
  seriesVenuePeriods,
  venueClaimCitations,
  venueNameVariants,
  venueSlugHistory,
  venues,
} from "../src/schema.js";

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let server: CapturingMcpServer;
let mock: ReturnType<typeof mockIndexNowFetch>;
const now = new Date("2026-10-01T00:00:00Z");

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerMergeEntitiesTools(server as never, db, { userId: "u-admin", role: "ADMIN" } as never);
  mock = mockIndexNowFetch();
  for (const [id, slug] of [
    ["keeper", "tunbridge-fairgrounds"],
    ["dup", "the-tunbridge-fair"],
  ])
    db.insert(venues)
      .values({
        id,
        name: slug,
        slug: unsafeSlug(slug),
        address: "1 Main",
        city: "Tunbridge",
        state: "VT",
        zip: "05077",
      })
      .run();
  db.insert(eventSeries)
    .values({
      id: "s1",
      canonicalSlug: unsafeSlug("tunbridge-worlds-fair"),
      name: "Tunbridge World's Fair",
      venueId: "dup",
    } as never)
    .run();
  db.insert(seriesVenuePeriods)
    .values({ id: "p1", seriesId: "s1", venueId: "dup", createdAt: now })
    .run();
  // One name only the loser carries, one both carry (UNIQUE venue_id+normalized_name).
  db.insert(venueNameVariants)
    .values([
      {
        id: "v-only",
        venueId: "dup",
        name: "Tunbridge Fair Grounds",
        normalizedName: "tunbridge fair grounds",
        createdAt: now,
      },
      {
        id: "v-dup",
        venueId: "dup",
        name: "Tunbridge World's Fair",
        normalizedName: "tunbridge worlds fair",
        createdAt: now,
      },
      {
        id: "v-keep",
        venueId: "keeper",
        name: "Tunbridge Worlds Fair",
        normalizedName: "tunbridge worlds fair",
        createdAt: now,
      },
    ])
    .run();
  db.insert(venueClaimCitations)
    .values([
      {
        id: "c-venue",
        venueId: "dup",
        field: "use_started",
        sourceUrl: "https://x",
        sourceType: "web",
        createdAt: now,
      },
      {
        id: "c-variant",
        venueNameVariantId: "v-dup",
        sourceUrl: "https://y",
        sourceType: "web",
        createdAt: now,
      },
    ])
    .run();
  // The loser's own earlier rename.
  db.insert(venueSlugHistory)
    .values({
      venueId: "dup",
      oldSlug: unsafeSlug("tunbridge-fair-vt"),
      newSlug: unsafeSlug("the-tunbridge-fair"),
      changedAt: now,
    })
    .run();
});
afterEach(() => mock.restore());

describe("merge_venue repoints every venue child (OPE-1232)", () => {
  it("moves series, periods, variants, citations and old redirects to the keeper", async () => {
    const r = (await server.invoke("merge_venue", {
      keeper_venue_id: "keeper",
      duplicate_venue_id: "dup",
    })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0].text);
    expect(out.children_repointed).toEqual({
      seriesRepointed: 1,
      periodsRepointed: 1,
      variantsRepointed: 1,
      variantsFolded: 1,
      citationsRepointed: 1,
      slugHistoryRepointed: 1,
    });

    expect(db.select().from(eventSeries).where(eq(eventSeries.id, "s1")).all()[0].venueId).toBe(
      "keeper"
    );
    expect(db.select().from(seriesVenuePeriods).all()[0].venueId).toBe("keeper");
    const variants = db
      .select()
      .from(venueNameVariants)
      .all()
      .map((v) => `${v.id}:${v.venueId}`)
      .sort();
    expect(variants).toEqual(["v-keep:keeper", "v-only:keeper"]);
    const cites = Object.fromEntries(
      db
        .select()
        .from(venueClaimCitations)
        .all()
        .map((c) => [c.id, c])
    );
    expect(cites["c-venue"].venueId).toBe("keeper");
    // The folded variant's citation survived, re-attached to the keeper's row.
    expect(cites["c-variant"].venueNameVariantId).toBe("v-keep");
    const old = db
      .select()
      .from(venueSlugHistory)
      .where(eq(venueSlugHistory.oldSlug, unsafeSlug("tunbridge-fair-vt")))
      .all();
    expect(old.map((h) => `${h.venueId} -> ${h.newSlug}`)).toEqual([
      "keeper -> tunbridge-fairgrounds",
    ]);
    // Nothing is left on the tombstone.
    for (const t of [
      "event_series",
      "series_venue_periods",
      "venue_name_variants",
      "venue_claim_citations",
      "venue_slug_history",
    ])
      expect(raw.prepare(`SELECT COUNT(*) n FROM ${t} WHERE venue_id = 'dup'`).get()).toEqual({
        n: 0,
      });
  });
});

/**
 * OPE-278 item 3 — the `-N` slug suffix is dedup's own failure receipt, and
 * nothing has ever listened to it.
 *
 * The tests that matter here are the NEGATIVE ones. A slug-shape-only check is
 * trivially easy to write and reports 42 open defects in prod where there are
 * 2; every case below that asserts *nothing* is reported is pinning a
 * false-positive class that the obvious implementation would have.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { findSlugCollisionPairs } from "../src/slug-collision-invariant.js";
import { events, promoters, venues } from "../src/schema.js";

let db: TestDb;

function seedFixtures() {
  db.insert(promoters).values({ id: "p-1", companyName: "P", slug: "p-1" }).run();
  db.insert(venues)
    .values({
      id: "v-1",
      name: "V1",
      slug: "v-1",
      address: "1 Main",
      city: "Bath",
      state: "ME",
      zip: "04530",
    })
    .run();
  db.insert(venues)
    .values({
      id: "v-2",
      name: "V2",
      slug: "v-2",
      address: "2 Main",
      city: "Bath",
      state: "ME",
      zip: "04530",
    })
    .run();
}

beforeEach(() => {
  ({ db } = createTestDb());
  seedFixtures();
});

const D = (iso: string) => new Date(iso);

function ev(over: Partial<typeof events.$inferInsert> & { id: string; slug: string }) {
  db.insert(events)
    .values({
      name: over.name ?? over.slug,
      promoterId: "p-1",
      status: "APPROVED",
      venueId: "v-1",
      ...over,
    })
    .run();
}

const pairs = () => findSlugCollisionPairs(db);

describe("slug_collision_live_pairs", () => {
  it("reports two live events differing only by a numeric suffix on the same date", async () => {
    ev({ id: "e-base", slug: "boston-marathon-2026", startDate: D("2026-04-20") });
    ev({
      id: "e-dup",
      slug: "boston-marathon-2026-1",
      startDate: D("2026-04-20"),
      status: "TENTATIVE",
    });

    const p = await pairs();
    expect(p.violation_count).toBe(1);
    expect(p.violations[0]).toMatchObject({
      dup_slug: "boston-marathon-2026-1",
      base_slug: "boston-marathon-2026",
    });
  });

  it("reports a same-date pair even at different venues", async () => {
    ev({ id: "e-base", slug: "first-night-boston-2027", startDate: D("2026-12-31") });
    ev({
      id: "e-dup",
      slug: "first-night-boston-2027-1",
      startDate: D("2026-12-31"),
      venueId: "v-2",
    });

    expect((await pairs()).violation_count).toBe(1);
  });

  it("does NOT report two editions a year apart — the case the date guard exists for", async () => {
    // Real prod rows: central-vermont-gun-show (2026-02-07, APPROVED) and
    // central-vermont-gun-show-1 (2027-02-06, TENTATIVE). Legitimately
    // different editions. A slug-shape-only check flags this forever.
    ev({ id: "e-base", slug: "central-vermont-gun-show", startDate: D("2026-02-07") });
    ev({
      id: "e-dup",
      slug: "central-vermont-gun-show-1",
      startDate: D("2027-02-06"),
      venueId: "v-2",
      status: "TENTATIVE",
    });

    expect((await pairs()).violation_count).toBe(0);
  });

  it("does NOT report a pair a human already rejected", async () => {
    // 42 events in prod carry a numeric suffix; nearly all look like this.
    ev({ id: "e-base", slug: "craftfest-cotuit-2026", startDate: D("2026-08-15") });
    ev({
      id: "e-dup",
      slug: "craftfest-cotuit-2026-1",
      startDate: D("2026-08-15"),
      status: "REJECTED",
    });

    expect((await pairs()).violation_count).toBe(0);
  });

  it("does NOT report a merged tombstone — merge_events leaves the loser in place", async () => {
    ev({ id: "e-base", slug: "stowe-foliage-2026", startDate: D("2026-10-09") });
    ev({
      id: "e-dup",
      slug: "stowe-foliage-2026-1",
      startDate: D("2026-10-09"),
      mergedInto: "e-base",
    });

    expect((await pairs()).violation_count).toBe(0);
  });

  it("does NOT report a year-suffixed slug as a numeric collision", async () => {
    // `...-2026` ends in a digit but is an edition slug, not a `-N` suffix.
    ev({ id: "e-a", slug: "fryeburg-fair-2026", startDate: D("2026-10-04") });
    ev({ id: "e-b", slug: "fryeburg-fair-2027", startDate: D("2027-10-03") });

    expect((await pairs()).violation_count).toBe(0);
  });

  it("does NOT report a suffixed slug with no live base twin", async () => {
    ev({ id: "e-dup", slug: "orphan-festival-1", startDate: D("2026-06-01") });
    expect((await pairs()).violation_count).toBe(0);
  });

  it("uses SECONDS for the 7-day window, not milliseconds", async () => {
    // A ms constant (604800000) would make the window ~19,000 years and match
    // everything; a s-vs-ms mix the other way matches nothing and reads as
    // "clean". 8 days apart must fall OUTSIDE.
    ev({ id: "e-base", slug: "edge-fair", startDate: D("2026-06-01") });
    ev({ id: "e-dup", slug: "edge-fair-1", startDate: D("2026-06-09") });
    expect((await pairs()).violation_count).toBe(0);

    ({ db } = createTestDb());
    seedFixtures();
    ev({ id: "e-base", slug: "edge-fair", startDate: D("2026-06-01") });
    ev({ id: "e-dup", slug: "edge-fair-1", startDate: D("2026-06-06") });
    expect((await pairs()).violation_count).toBe(1);
  });
});

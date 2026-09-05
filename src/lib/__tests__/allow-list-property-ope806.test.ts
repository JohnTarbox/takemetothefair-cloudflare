/**
 * OPE-806 — the published-allow-list invariant, as ONE property across every
 * entity type rather than five per-type examples.
 *
 * > Every identifier a scanner asserts on must be present in the published
 * > allow-list for its entity type, or excluded from it with a stated reason.
 *
 * ## Why a property and not examples
 *
 * The 2026-09-05 retro declined the general form of this guard ("two code paths
 * that construct the same thing must share a builder") as statically
 * undecidable, and authorised this narrow form precisely because it is testable
 * as a property. A per-type example test passes for the four types someone
 * remembered and says nothing about the fifth — which is how vendors ended up
 * with an allow-list that gated only the guaranteed block while the filler
 * tiers recycled noindex URLs straight past it.
 *
 * ## What it costs when the guard is absent
 *
 * OPE-372, the family's confirmed specimen: **81 of 318 open `health_issues`
 * rows — 25% of an operator queue — were self-manufactured and regenerated
 * daily**, because the sitemap builder and the sweep's picker built the same
 * URLs from different fields under different gates.
 *
 * ## The recycling sources are the point
 *
 * Each case below seeds its non-canonical identifier into `gsc_inspection_state`
 * or `time_to_index_log` — the tables the filler tiers read back out of. A fix
 * wired only into the constructors would pass a test that seeded the
 * constructors, and would still refill the queue from its own history. Three of
 * the six tiers read from these tables.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { pickUrls } from "../gsc-sweep";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
const HOST = "https://meetmeatthefair.com";

const SCHEMA_SQL = `
  CREATE TABLE gsc_inspection_state (
    url TEXT PRIMARY KEY,
    last_inspected_at INTEGER,
    last_verdict TEXT,
    last_coverage_state TEXT,
    source TEXT
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'APPROVED',
    lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    venue_id TEXT,
    updated_at INTEGER,
    -- OPE-372: the sweep now derives event URLs from the sitemap's gate, which
    -- reads these three. Defaults keep every pre-existing fixture in this file
    -- eligible (completeness 80 clears the sitemap's 40 floor, series_id NULL
    -- means "standalone" → /events/<slug>, the shape these tests assert).
    completeness_score INTEGER DEFAULT 80,
    start_date INTEGER DEFAULT 1790000000,
    end_date INTEGER,
    series_id TEXT
  );
  CREATE TABLE event_series (
    id TEXT PRIMARY KEY,
    canonical_slug TEXT NOT NULL
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    city TEXT,
    state TEXT,
    updated_at INTEGER
  );
  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    updated_at INTEGER,
    business_name TEXT,
    display_name TEXT,
    description TEXT,
    website TEXT,
    social_links TEXT,
    city TEXT,
    state TEXT,
    address TEXT,
    enhanced_profile INTEGER NOT NULL DEFAULT 0,
    domain_hijacked INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    alias_of_vendor_id TEXT,
    role TEXT,
    display_override_permitted INTEGER NOT NULL DEFAULT 0,
    display_mode TEXT,
    brand_parent_vendor_id TEXT,
    operator_parent_vendor_id TEXT,
    default_child_display TEXT
  );
  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    event_id TEXT NOT NULL
  );
  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    updated_at INTEGER
  );
  CREATE TABLE time_to_index_log (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    indexnow_submitted_at INTEGER NOT NULL,
    first_crawl_at INTEGER,
    lag_seconds INTEGER,
    computed_at INTEGER NOT NULL
  );
  -- OPE-567 follow-up: Tier 0 re-inspects URLs carrying an open ERROR row.
  -- The harness builds its schema from inline CREATE TABLE rather than from
  -- migrations, so a new table pickUrls reads must be added here too or every
  -- test in the file dies on "no such table" (reference_d1_and_migration_gotchas).
  CREATE TABLE health_issues (
    id TEXT PRIMARY KEY,
    fingerprint TEXT,
    source TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    url TEXT,
    message TEXT,
    first_detected_at INTEGER NOT NULL,
    last_detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution_reason TEXT,
    last_reverified_at INTEGER,
    snoozed_until INTEGER
  );
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});
afterEach(() => raw.close());

/** Seed an identifier into a tier's RECYCLING source, not into its constructor. */
function seedRecycled(url: string) {
  raw
    .prepare(
      `INSERT INTO gsc_inspection_state (url, last_inspected_at, last_verdict, source)
       VALUES (?, ?, 'NEUTRAL', 'sweep')`
    )
    .run(url, 0); // last_inspected 0 = oldest, so the round-robin tier picks it first
  raw
    .prepare(
      `INSERT INTO time_to_index_log (id, url, indexnow_submitted_at, first_crawl_at, computed_at)
       VALUES (?, ?, ?, NULL, ?)`
    )
    .run(crypto.randomUUID(), url, 1_750_000_000, 1_750_000_000);
}

/**
 * One row per entity type: what the sitemap publishes, and a plausible
 * identifier it does NOT publish.
 *
 * The excluded values are the real exclusion reasons for each type, not
 * arbitrary strings — an ARCHIVED venue, a DRAFT post, a soft-deleted vendor.
 */
const CASES = [
  {
    type: "venues",
    published: `${HOST}/venues/portland-expo`,
    excluded: `${HOST}/venues/archived-hall`,
    reason: "venues.status <> 'ACTIVE'",
    seed: () => {
      raw
        .prepare(`INSERT INTO venues (id, slug, status) VALUES (?, ?, ?)`)
        .run("v1", "portland-expo", "ACTIVE");
      raw
        .prepare(`INSERT INTO venues (id, slug, status) VALUES (?, ?, ?)`)
        .run("v2", "archived-hall", "ARCHIVED");
    },
  },
  {
    type: "blog",
    published: `${HOST}/blog/big-e-parking`,
    excluded: `${HOST}/blog/unpublished-draft`,
    reason: "blog_posts.status <> 'PUBLISHED'",
    seed: () => {
      raw
        .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, ?)`)
        .run("b1", "big-e-parking", "PUBLISHED");
      raw
        .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, ?)`)
        .run("b2", "unpublished-draft", "DRAFT");
    },
  },
  {
    type: "promoters",
    published: `${HOST}/promoters/maine-fairs`,
    // Promoters have no status column, so nothing is excluded by gate — the
    // exclusion is "this row does not exist", which is what a recycled URL for
    // a deleted promoter looks like.
    excluded: `${HOST}/promoters/deleted-org`,
    reason: "no such promoter row",
    seed: () => {
      raw.prepare(`INSERT INTO promoters (id, slug) VALUES (?, ?)`).run("p1", "maine-fairs");
    },
  },
  {
    type: "vendors",
    published: `${HOST}/vendors/kettle-corn-co`,
    excluded: `${HOST}/vendors/soft-deleted-co`,
    reason: "vendors.deleted_at IS NOT NULL",
    seed: () => {
      // Field set copied from the existing pick-urls harness — the real
      // indexable gate walks event_vendors -> events -> venues for a
      // geographic anchor and then applies `isIndexableTier`, so a
      // hand-invented row does NOT clear it. My first fixture didn't, and the
      // positive case correctly went red rather than quietly passing.
      raw
        .prepare(
          `INSERT INTO vendors (id, slug, enhanced_profile, domain_hijacked, deleted_at, alias_of_vendor_id, role)
           VALUES (?, ?, 1, 0, NULL, NULL, 'INDEPENDENT')`
        )
        .run("vd1", "kettle-corn-co");
      raw
        .prepare(
          `INSERT INTO vendors (id, slug, enhanced_profile, domain_hijacked, deleted_at, role)
           VALUES (?, ?, 1, 0, 1730000000, 'INDEPENDENT')`
        )
        .run("vd2", "soft-deleted-co");
    },
  },
] as const;

describe("OPE-806 — the allow-list property, across every entity type", () => {
  it.each(CASES)(
    "$type: a non-published identifier recycled from a tier source is never inspected",
    async ({ excluded, seed }) => {
      seed();
      seedRecycled(excluded);
      const urls = await pickUrls(db as never, 50);
      expect(urls).not.toContain(excluded);
    }
  );

  it.each(CASES)(
    "$type: the PUBLISHED identifier still gets inspected — no blind spot traded",
    async ({ published, seed }) => {
      // The positive half, and the one that matters most. A choke point that
      // dropped everything would satisfy every assertion above. OPE-806 names
      // the exact failure this guards: 67 sitemap URLs legitimately match
      // `/events/<slug>-<year>`, and shape-filtering would have stopped
      // inspecting all 67 real pages.
      seed();
      seedRecycled(published);
      const urls = await pickUrls(db as never, 50);
      expect(urls).toContain(published);
    }
  );

  it("a URL under a prefix we do NOT govern passes through untouched", async () => {
    // The drop must be positive knowledge ("the sitemap withholds this"), never
    // an absence of knowledge. Static pages have no allow-list and must not be
    // silently dropped.
    const staticUrl = `${HOST}/about`;
    seedRecycled(staticUrl);
    const urls = await pickUrls(db as never, 50);
    expect(urls).toContain(staticUrl);
  });

  it("covers every entity type the sweep can pick — the list cannot silently shrink", () => {
    // Positive landmark on the CASES table itself. If someone deletes a case,
    // the it.each blocks above simply run fewer times and stay green — the
    // vacuous-coverage shape this whole ticket is about.
    expect(CASES.map((c) => c.type).sort()).toEqual(["blog", "promoters", "vendors", "venues"]);
    for (const c of CASES) expect(c.reason.length).toBeGreaterThan(0);
  });
});

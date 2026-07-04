/**
 * REL5 (2026-06-16) — pickUrls now prioritizes unresolved time_to_index_log
 * URLs so the GSC URL Inspection sweep actually measures the URLs we submit to
 * IndexNow. Before this, submitted URLs that hadn't already been inspected were
 * invisible to the inspector, so the reconciler had no PASS verdict to join
 * against and first_crawl_at stayed NULL across all rows.
 *
 * In-memory better-sqlite3 harness (same pattern as event-outbound-clicks.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { pickUrls } from "../gsc-sweep";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const HOST = "https://meetmeatthefair.com";

// Minimal columns pickUrls touches across its tiers. A10/A11 (2026-06-26) added
// per-type guaranteed coverage (venues/promoters/blog/events/vendors) + the
// shared indexable-vendor gate, so the harness now needs those tables/columns.
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
    updated_at INTEGER
  );
  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    city TEXT,
    state TEXT
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
`;

let raw: Database.Database;
let db: TestDb;

beforeEach(() => {
  raw = new Database(":memory:");
  raw["exec"](SCHEMA_SQL);
  db = drizzle(raw, { schema });
});

afterEach(() => {
  raw.close();
});

function seedSubmission(url: string, submittedIso: string, firstCrawlIso: string | null) {
  raw
    .prepare(
      `INSERT INTO time_to_index_log (id, url, indexnow_submitted_at, first_crawl_at, computed_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      url,
      Math.floor(new Date(submittedIso).getTime() / 1000),
      firstCrawlIso ? Math.floor(new Date(firstCrawlIso).getTime() / 1000) : null,
      Math.floor(new Date(submittedIso).getTime() / 1000)
    );
}

describe("REL5 — pickUrls surfaces unresolved time_to_index_log URLs", () => {
  it("includes submitted-but-unresolved URLs and excludes resolved ones", async () => {
    seedSubmission(`${HOST}/events/unresolved-a`, "2026-06-01T00:00:00Z", null);
    seedSubmission(`${HOST}/events/unresolved-b`, "2026-06-02T00:00:00Z", null);
    // Already resolved — must NOT be re-picked by this tier.
    seedSubmission(`${HOST}/events/resolved`, "2026-05-01T00:00:00Z", "2026-05-03T00:00:00Z");

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/events/unresolved-a`);
    expect(urls).toContain(`${HOST}/events/unresolved-b`);
    expect(urls).not.toContain(`${HOST}/events/resolved`);
  });

  it("skips non-own-host URLs in the log (the inspector resolves a path on our property)", async () => {
    seedSubmission("https://someoneelse.example/events/x", "2026-06-01T00:00:00Z", null);
    seedSubmission(`${HOST}/blog/mine`, "2026-06-01T00:00:00Z", null);

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/blog/mine`);
    expect(urls).not.toContain("https://someoneelse.example/events/x");
  });

  it("respects the filler budget (no entities seeded → guaranteed set empty, filler capped at batchSize)", async () => {
    for (let i = 0; i < 10; i++) {
      seedSubmission(`${HOST}/events/e${i}`, `2026-06-0${(i % 9) + 1}T00:00:00Z`, null);
    }
    const urls = await pickUrls(db as never, 4);
    expect(urls.length).toBeLessThanOrEqual(4);
  });
});

describe("A10/A11 — per-page-type guaranteed coverage", () => {
  it("includes a venue, promoter, blog, event AND indexable vendor each run", async () => {
    raw
      .prepare(
        `INSERT INTO events (id, slug, status, lifecycle_status) VALUES (?, ?, 'APPROVED', 'SCHEDULED')`
      )
      .run("e1", "an-event");
    raw
      .prepare(
        `INSERT INTO venues (id, slug, status, city, state) VALUES (?, ?, 'ACTIVE', 'Skowhegan', 'ME')`
      )
      .run("v1", "a-venue");
    raw.prepare(`INSERT INTO promoters (id, slug) VALUES (?, ?)`).run("p1", "a-promoter");
    raw
      .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, 'PUBLISHED')`)
      .run("b1", "a-post");
    // An indexable vendor: enhanced_profile=1, not deleted/hijacked/aliased.
    raw
      .prepare(
        `INSERT INTO vendors (id, slug, enhanced_profile, domain_hijacked, deleted_at, alias_of_vendor_id, role)
         VALUES (?, ?, 1, 0, NULL, NULL, 'INDEPENDENT')`
      )
      .run("vd1", "a-vendor");

    const urls = await pickUrls(db as never, 200);
    expect(urls).toContain(`${HOST}/venues/a-venue`);
    expect(urls).toContain(`${HOST}/promoters/a-promoter`);
    expect(urls).toContain(`${HOST}/blog/a-post`);
    expect(urls).toContain(`${HOST}/events/an-event`);
    expect(urls).toContain(`${HOST}/vendors/a-vendor`);
  });

  it("excludes a non-indexable vendor (soft-deleted) from the sample", async () => {
    raw
      .prepare(
        `INSERT INTO vendors (id, slug, enhanced_profile, domain_hijacked, deleted_at, role)
         VALUES (?, ?, 1, 0, 1730000000, 'INDEPENDENT')`
      )
      .run("vd-del", "deleted-vendor");

    const urls = await pickUrls(db as never, 200);
    expect(urls).not.toContain(`${HOST}/vendors/deleted-vendor`);
  });

  // OPE-91 regression: with the default batchSize=8 and a FULL Tier-1 stale
  // backlog (8 non-OK event rows), the old `[...picked].slice(0, batchSize)`
  // discarded every per-type URL — blog/vendor/venue/promoter were never
  // inspected, so gsc_inspection_state had 0 blog rows. The guaranteed per-type
  // coverage must survive regardless of how full the Tier-1 filler is.
  it("does NOT truncate per-type coverage when Tier 1 (stale) is full at batchSize=8", async () => {
    // 8 stale (non-OK) event rows — exactly fills the default batch budget.
    for (let i = 0; i < 8; i++) {
      raw
        .prepare(
          `INSERT INTO gsc_inspection_state (url, last_inspected_at, last_verdict) VALUES (?, ?, 'FAIL')`
        )
        .run(`${HOST}/events/stale-${i}`, 1_700_000_000);
    }
    // Published blog posts that MUST still be sampled into the guaranteed set.
    raw
      .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, 'PUBLISHED')`)
      .run("b1", "guaranteed-post-a");
    raw
      .prepare(`INSERT INTO blog_posts (id, slug, status) VALUES (?, ?, 'PUBLISHED')`)
      .run("b2", "guaranteed-post-b");

    const urls = await pickUrls(db as never, 8);
    // Blog coverage survives the full Tier-1 filler (the whole point of OPE-91).
    expect(urls).toContain(`${HOST}/blog/guaranteed-post-a`);
    expect(urls).toContain(`${HOST}/blog/guaranteed-post-b`);
    // And a Tier-1 stale event still made it into the filler budget.
    expect(urls.some((u) => u.startsWith(`${HOST}/events/stale-`))).toBe(true);
  });
});

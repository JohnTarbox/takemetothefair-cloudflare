/**
 * OPE-793 — merging two events that carry SEPARATE series must not collide on
 * `event_series.canonical_slug`.
 *
 * Reproduced in production twice on the Manchester Grange pair (2026-09-03),
 * whose two events AND two series rows were minted four seconds apart by a
 * single inbound submission. `preview:true` reported `canMerge:true,
 * warnings:[]` immediately before each failure, and the operator got:
 *
 *   D1_ERROR: UNIQUE constraint failed: event_series.canonical_slug
 *
 * ## Why real SQLite, with the real UNIQUE index
 *
 * The sibling `merge-operations.test.ts` drives a hand-built mock whose
 * `where()` returns `[]`. A mock cannot raise a uniqueness violation, so it
 * would pass in full with this defect present — it did, for as long as the
 * defect existed. The constraint IS the condition under test, so the fixture
 * declares `canonical_slug TEXT NOT NULL UNIQUE` and lets the database enforce
 * it. Reproducing the inequality, not its neighbourhood.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema";
import { executeMerge } from "../merge-operations";

/**
 * Generated from the real drizzle schema rather than hand-written, so a column
 * the merge reads cannot be quietly absent from the fixture — and so
 * `event_series.canonical_slug`'s UNIQUE, which is the entire condition under
 * test, is the one the production schema actually declares.
 */
const SCHEMA_SQL = `
  CREATE TABLE admin_actions (
    id text PRIMARY KEY,
    action text NOT NULL DEFAULT '',
    actor_user_id text,
    target_type text NOT NULL DEFAULT '',
    target_id text NOT NULL DEFAULT '',
    payload_json text,
    created_at integer NOT NULL DEFAULT 0
  );
  CREATE TABLE content_links (
    id text PRIMARY KEY,
    source_type text NOT NULL DEFAULT '',
    source_id text NOT NULL DEFAULT '',
    target_type text NOT NULL DEFAULT '',
    target_slug text NOT NULL DEFAULT '',
    target_id text,
    created_at integer,
    notified_at integer
  );
  CREATE TABLE event_data_citations (
    id text PRIMARY KEY,
    event_id text NOT NULL DEFAULT '',
    field_name text NOT NULL DEFAULT '',
    value text NOT NULL DEFAULT '',
    year integer,
    source_url text NOT NULL DEFAULT '',
    source_name text,
    source_type text NOT NULL DEFAULT '',
    confidence real,
    state text NOT NULL DEFAULT '',
    notes text,
    supersedes_citation_id text,
    created_by text,
    source_title text,
    source_excerpt text,
    source_content_hash text,
    source_fetched_at integer,
    recheck_state text,
    recheck_at integer,
    recheck_note text,
    created_at integer NOT NULL DEFAULT 0,
    updated_at integer NOT NULL DEFAULT 0
  );
  CREATE TABLE event_days (
    id text PRIMARY KEY,
    event_id text NOT NULL DEFAULT '',
    date text NOT NULL DEFAULT '',
    open_time text,
    close_time text,
    notes text,
    internal_notes text,
    closed integer,
    vendor_only integer,
    image_url text,
    image_focal_x real NOT NULL DEFAULT 0,
    image_focal_y real NOT NULL DEFAULT 0,
    created_at integer
  );
  CREATE TABLE event_series (
    id text PRIMARY KEY,
    canonical_slug text NOT NULL DEFAULT '',
    name text NOT NULL DEFAULT '',
    venue_id text,
    promoter_id text,
    recurrence_rule text,
    description text,
    image_url text,
    categories text,
    tags text,
    primary_audience text NOT NULL DEFAULT '',
    public_access text NOT NULL DEFAULT '',
    created_at integer,
    updated_at integer,
    UNIQUE(canonical_slug)
  );
  CREATE TABLE event_slug_history (
    id text PRIMARY KEY,
    event_id text NOT NULL DEFAULT '',
    old_slug text NOT NULL DEFAULT '',
    new_slug text NOT NULL DEFAULT '',
    changed_at integer NOT NULL DEFAULT 0,
    changed_by text
  );
  CREATE TABLE event_vendors (
    id text PRIMARY KEY,
    event_id text NOT NULL DEFAULT '',
    vendor_id text NOT NULL DEFAULT '',
    booth_info text,
    status text NOT NULL DEFAULT '',
    payment_status text NOT NULL DEFAULT '',
    participation_type text NOT NULL DEFAULT '',
    event_day_id text,
    public_visible integer NOT NULL DEFAULT 0,
    created_at integer,
    updated_at integer
  );
  CREATE TABLE events (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    slug text NOT NULL DEFAULT '',
    description text,
    promoter_id text NOT NULL DEFAULT '',
    venue_id text,
    state_code text,
    is_statewide integer NOT NULL DEFAULT 0,
    start_date integer,
    end_date integer,
    public_start_date integer,
    public_end_date integer,
    dates_confirmed integer,
    recurrence_rule text,
    categories text,
    tags text,
    ticket_url text,
    ticket_price_min_cents integer,
    ticket_price_max_cents integer,
    image_url text,
    featured integer,
    commercial_vendors_allowed integer,
    status text NOT NULL DEFAULT '',
    view_count integer,
    source_name text,
    source_domain text,
    ingestion_method text,
    source_url text,
    source_id text,
    sync_enabled integer,
    last_synced_at integer,
    discontinuous_dates integer,
    vendor_fee_min_cents integer,
    vendor_fee_max_cents integer,
    vendor_fee_notes text,
    indoor_outdoor text,
    estimated_attendance integer,
    event_scale text,
    application_deadline integer,
    application_url text,
    application_instructions text,
    walk_ins_allowed integer,
    suggester_email text,
    submitted_by_user_id text,
    approval_notified_at integer,
    og_image_sweep_attempted_at integer,
    merged_into text,
    possible_duplicate_of text,
    rejected_as_duplicate_of text,
    rolled_from_event_id text,
    series_id text,
    completeness_score integer NOT NULL DEFAULT 0,
    lifecycle_status text NOT NULL DEFAULT '',
    lifecycle_status_changed_at integer,
    lifecycle_reason text,
    previous_start_date integer,
    previous_end_date integer,
    gate_flags text,
    flagged_for_review integer NOT NULL DEFAULT 0,
    primary_audience text NOT NULL DEFAULT '',
    public_access text NOT NULL DEFAULT '',
    access_notes text,
    registration_required integer NOT NULL DEFAULT 0,
    created_at integer,
    updated_at integer,
    image_focal_x real NOT NULL DEFAULT 0,
    image_focal_y real NOT NULL DEFAULT 0,
    syndication_version integer NOT NULL DEFAULT 0,
    vendor_roster_status text,
    vendor_roster_checked_at integer,
    vendor_roster_source_url text,
    vendor_roster_offset integer,
    performer_roster_status text,
    performer_roster_checked_at integer,
    performer_roster_source_url text,
    UNIQUE(slug)
  );
  CREATE TABLE promoters (
    id text PRIMARY KEY,
    user_id text,
    company_name text NOT NULL DEFAULT '',
    slug text NOT NULL DEFAULT '',
    description text,
    website text,
    social_links text,
    logo_url text,
    hero_image_url text,
    city text,
    state text,
    contact_email text,
    contact_phone text,
    verified integer,
    created_at integer,
    updated_at integer,
    image_focal_x real NOT NULL DEFAULT 0,
    image_focal_y real NOT NULL DEFAULT 0,
    vendor_roster_publishes_lists integer,
    enrichment_status text,
    enrichment_coverage text,
    last_enriched_at integer,
    enrichment_blocked_reason text,
    enrichment_attempted_at integer,
    claimed integer NOT NULL DEFAULT 0,
    claimed_at integer,
    claimed_by text,
    UNIQUE(user_id),
    UNIQUE(slug)
  );
  CREATE TABLE series_slug_history (
    id text PRIMARY KEY,
    series_id text NOT NULL DEFAULT '',
    old_slug text NOT NULL DEFAULT '',
    new_slug text NOT NULL DEFAULT '',
    changed_at integer NOT NULL DEFAULT 0,
    changed_by text
  );
  CREATE TABLE user_favorites (
    id text PRIMARY KEY,
    user_id text NOT NULL DEFAULT '',
    favoritable_type text NOT NULL DEFAULT '',
    favoritable_id text NOT NULL DEFAULT '',
    created_at integer
  );
  CREATE TABLE users (
    id text PRIMARY KEY,
    email text NOT NULL DEFAULT '',
    password_hash text,
    origin text NOT NULL DEFAULT '',
    name text,
    role text NOT NULL DEFAULT '',
    email_verified integer,
    image text,
    oauth_provider text,
    created_at integer,
    updated_at integer,
    UNIQUE(email)
  );
  CREATE TABLE vendors (
    id text PRIMARY KEY,
    user_id text NOT NULL DEFAULT '',
    business_name text NOT NULL DEFAULT '',
    display_name text,
    slug text NOT NULL DEFAULT '',
    description text,
    vendor_type text,
    products text,
    website text,
    social_links text,
    logo_url text,
    verified integer,
    commercial integer,
    can_self_confirm integer,
    contact_name text,
    contact_email text,
    contact_phone text,
    address text,
    city text,
    state text,
    zip text,
    latitude real,
    longitude real,
    year_established integer,
    payment_methods text,
    license_info text,
    insurance_info text,
    enhanced_profile integer NOT NULL DEFAULT 0,
    enhanced_profile_started_at integer,
    enhanced_profile_expires_at integer,
    gallery_images text NOT NULL DEFAULT '',
    featured_priority integer NOT NULL DEFAULT 0,
    claimed integer NOT NULL DEFAULT 0,
    claimed_at integer,
    claimed_by text,
    view_count integer NOT NULL DEFAULT 0,
    verified_pro integer NOT NULL DEFAULT 0,
    verified_pro_at integer,
    verified_pro_by text,
    deleted_at integer,
    redirect_to_vendor_id text,
    enrichment_source text,
    enrichment_attempted_at integer,
    domain_hijacked integer NOT NULL DEFAULT 0,
    completeness_score integer NOT NULL DEFAULT 0,
    role text NOT NULL DEFAULT '',
    brand_parent_vendor_id text,
    operator_parent_vendor_id text,
    alias_of_vendor_id text,
    relationship_type text NOT NULL DEFAULT '',
    default_child_display text,
    display_override_permitted integer NOT NULL DEFAULT 0,
    display_mode text,
    created_at integer,
    updated_at integer,
    image_focal_x real NOT NULL DEFAULT 0,
    image_focal_y real NOT NULL DEFAULT 0,
    UNIQUE(user_id),
    UNIQUE(slug)
  );
  CREATE TABLE venues (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    slug text NOT NULL DEFAULT '',
    address text NOT NULL DEFAULT '',
    city text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT '',
    zip text NOT NULL DEFAULT '',
    location_id text,
    location_matched_by text,
    location_match_km real,
    latitude real,
    longitude real,
    capacity integer,
    amenities text,
    contact_email text,
    contact_phone text,
    website text,
    description text,
    image_url text,
    google_place_id text,
    google_maps_url text,
    opening_hours text,
    google_rating real,
    google_rating_count integer,
    google_types text,
    accessibility text,
    parking text,
    status text NOT NULL DEFAULT '',
    timezone text NOT NULL DEFAULT '',
    locale text NOT NULL DEFAULT '',
    country text NOT NULL DEFAULT '',
    created_at integer,
    updated_at integer,
    image_focal_x real NOT NULL DEFAULT 0,
    image_focal_y real NOT NULL DEFAULT 0,
    UNIQUE(slug)
  );
`;

/** The live production rows, to shape. */
const KEEPER_ID = "018f8c98-53bb-4de2-9fc2-a6840ba8cb9b";
const DUP_ID = "eec93e7e-fff6-46fd-bb78-667dbd376946";
const KEEPER_SLUG = "manchester-grange-fall-craft-fair";
const DUP_SLUG = "manchester-grange-2026-fall-craft-fair";
const KEEPER_SERIES = "60648d5b-e9e2-427a-a3b3-80496ed43ae2";
const DUP_SERIES = "b4d9687d-9053-4b22-9b49-f52a3343274b";
const VENUE = "72d700c3-fdaa-4162-be6a-e4e806b0f82d";
const START = Math.floor(Date.parse("2026-10-24T12:00:00Z") / 1000);

let raw: InstanceType<typeof Database>;
let db: ReturnType<typeof drizzle<typeof schema>>;

function seedSeries(id: string, slug: string) {
  raw
    .prepare(
      `INSERT INTO event_series (id, canonical_slug, name, primary_audience, public_access, created_at)
       VALUES (?,?,?, 'PUBLIC', 'OPEN', 0)`
    )
    .run(id, slug, slug);
}
function seedEvent(id: string, slug: string, seriesId: string | null) {
  raw
    .prepare(
      `INSERT INTO events (id, slug, name, status, start_date, end_date, venue_id, promoter_id, series_id, view_count, is_statewide)
       VALUES (?,?,?, 'APPROVED', ?, ?, ?, 'promoter-1', ?, 0, 0)`
    )
    .run(id, slug, slug, START, START, VENUE, seriesId);
}

/**
 * `db.batch()` is a D1 API that better-sqlite3's driver does not implement.
 * Run the statements in order and collect their results.
 *
 * ⚠️ One real difference from D1, stated rather than papered over: D1's batch is
 * ATOMIC and this shim is not, so a mid-batch throw leaves earlier statements
 * applied here where production would roll them back. That does not weaken what
 * these tests assert — the defect is that the batch throws AT ALL, and the
 * throw reproduces identically either way — but it does mean this fixture must
 * not be used to reason about partial-merge states.
 */
function withBatch<T extends object>(d: T): T {
  return Object.assign(d, {
    batch: async (stmts: Array<PromiseLike<unknown>>) => {
      const out: unknown[] = [];
      for (const stmt of stmts) out.push(await stmt);
      return out;
    },
  });
}

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(SCHEMA_SQL);
  db = withBatch(drizzle(raw, { schema }));
});

const seriesSlug = (id: string) =>
  (
    raw.prepare(`SELECT canonical_slug FROM event_series WHERE id = ?`).get(id) as {
      canonical_slug: string;
    }
  ).canonical_slug;

describe("executeMerge — two events, two series (OPE-793)", () => {
  beforeEach(() => {
    seedSeries(KEEPER_SERIES, KEEPER_SLUG);
    seedSeries(DUP_SERIES, DUP_SLUG);
    seedEvent(KEEPER_ID, KEEPER_SLUG, KEEPER_SERIES);
    seedEvent(DUP_ID, DUP_SLUG, DUP_SERIES);
  });

  it("completes instead of dying on UNIQUE constraint failed: event_series.canonical_slug", async () => {
    // The whole ticket, as one assertion. Before the fix this threw.
    await expect(
      executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1")
    ).resolves.toBeDefined();
  });

  it("tombstones the duplicate and frees its URL", async () => {
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    const dup = raw
      .prepare(`SELECT slug, status, merged_into FROM events WHERE id = ?`)
      .get(DUP_ID) as {
      slug: string;
      status: string;
      merged_into: string;
    };
    expect(dup.status).toBe("REJECTED");
    expect(dup.merged_into).toBe(KEEPER_ID);
    expect(dup.slug).toBe(`${DUP_SLUG}-merged-${DUP_ID.slice(0, 8)}`);
  });

  it("301s the old event slug to the keeper", async () => {
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    const hist = raw
      .prepare(`SELECT old_slug, new_slug FROM event_slug_history WHERE old_slug = ?`)
      .get(DUP_SLUG) as { old_slug: string; new_slug: string };
    expect(hist.new_slug).toBe(KEEPER_SLUG);
  });

  it("leaves the KEEPER's series slug untouched — it is already correct", async () => {
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    expect(seriesSlug(KEEPER_SERIES)).toBe(KEEPER_SLUG);
  });

  it("tombstones the duplicate's series slug rather than colliding onto the keeper's", async () => {
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    expect(seriesSlug(DUP_SERIES)).toBe(`${DUP_SLUG}-merged-${DUP_ID.slice(0, 8)}`);
    // And no two series share a slug, which is the invariant D1 was enforcing.
    const slugs = raw.prepare(`SELECT canonical_slug FROM event_series`).all() as {
      canonical_slug: string;
    }[];
    expect(new Set(slugs.map((s) => s.canonical_slug)).size).toBe(slugs.length);
  });

  it("301s the retired SERIES slug to the keeper — the redirect survives the fix", async () => {
    // OPE-471's redirect must not be a casualty of avoiding the collision. This
    // is also why the eventless series row is kept rather than deleted:
    // series_slug_history cascades on series_id, so a delete takes the redirect.
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    const hist = raw
      .prepare(`SELECT old_slug, new_slug, series_id FROM series_slug_history WHERE old_slug = ?`)
      .get(DUP_SLUG) as { old_slug: string; new_slug: string; series_id: string };
    expect(hist).toBeDefined();
    expect(hist.new_slug).toBe(KEEPER_SLUG);
    expect(hist.series_id).toBe(DUP_SERIES);
  });
});

describe("executeMerge — both events share ONE series (the OPE-423 shape)", () => {
  // The behaviour OPE-423 added must be unchanged: when the slug is free, the
  // series is repointed onto the keeper, not tombstoned. A fix that tombstoned
  // in both cases would pass every test above and silently retire a live hub.
  beforeEach(() => {
    seedSeries(DUP_SERIES, DUP_SLUG); // the ONLY series, named after the duplicate
    seedEvent(KEEPER_ID, KEEPER_SLUG, DUP_SERIES);
    seedEvent(DUP_ID, DUP_SLUG, DUP_SERIES);
  });

  it("repoints the shared series onto the keeper's slug", async () => {
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    expect(seriesSlug(DUP_SERIES)).toBe(KEEPER_SLUG);
  });

  it("still records the series redirect", async () => {
    await executeMerge(db as never, "events", KEEPER_ID, DUP_ID, "admin-1");
    const hist = raw
      .prepare(`SELECT new_slug FROM series_slug_history WHERE old_slug = ?`)
      .get(DUP_SLUG) as { new_slug: string } | undefined;
    expect(hist?.new_slug).toBe(KEEPER_SLUG);
  });
});

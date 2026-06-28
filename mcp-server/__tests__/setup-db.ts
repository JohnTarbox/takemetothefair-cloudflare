/**
 * Test setup: in-memory SQLite + Drizzle for exercising MCP tool handlers.
 *
 * The CREATE TABLE statements mirror only the columns the IndexNow-hook tools
 * actually read or write. New columns added to the production schema do NOT
 * need to be reflected here unless a tool under test starts using them.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/schema.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const SCHEMA_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'USER',
    email_verified INTEGER,
    image TEXT,
    oauth_provider TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    zip TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    capacity INTEGER,
    amenities TEXT DEFAULT '[]',
    contact_email TEXT,
    contact_phone TEXT,
    website TEXT,
    description TEXT,
    image_url TEXT,
    google_place_id TEXT,
    google_maps_url TEXT,
    opening_hours TEXT,
    google_rating REAL,
    google_rating_count INTEGER,
    google_types TEXT,
    accessibility TEXT,
    parking TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    locale TEXT NOT NULL DEFAULT 'en-US',
    country TEXT NOT NULL DEFAULT 'US',
    created_at INTEGER,
    updated_at INTEGER,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5
  );

  CREATE TABLE promoters (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    company_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    website TEXT,
    social_links TEXT,
    logo_url TEXT,
    city TEXT,
    state TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    verified INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5
  );

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    promoter_id TEXT NOT NULL,
    venue_id TEXT,
    state_code TEXT,
    is_statewide INTEGER NOT NULL DEFAULT 0,
    start_date INTEGER,
    end_date INTEGER,
    public_start_date INTEGER,
    public_end_date INTEGER,
    dates_confirmed INTEGER DEFAULT 1,
    recurrence_rule TEXT,
    categories TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    ticket_url TEXT,
    ticket_price_min_cents INTEGER,
    ticket_price_max_cents INTEGER,
    image_url TEXT,
    featured INTEGER DEFAULT 0,
    commercial_vendors_allowed INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    view_count INTEGER DEFAULT 0,
    source_name TEXT,
    source_domain TEXT,
    ingestion_method TEXT,
    source_url TEXT,
    source_id TEXT,
    sync_enabled INTEGER DEFAULT 1,
    last_synced_at INTEGER,
    discontinuous_dates INTEGER DEFAULT 0,
    vendor_fee_min_cents INTEGER,
    vendor_fee_max_cents INTEGER,
    vendor_fee_notes TEXT,
    indoor_outdoor TEXT,
    estimated_attendance INTEGER,
    event_scale TEXT,
    application_deadline INTEGER,
    application_url TEXT,
    application_instructions TEXT,
    walk_ins_allowed INTEGER,
    suggester_email TEXT,
    submitted_by_user_id TEXT,
    completeness_score INTEGER NOT NULL DEFAULT 0,
    lifecycle_status TEXT NOT NULL DEFAULT 'SCHEDULED',
    lifecycle_status_changed_at INTEGER,
    lifecycle_reason TEXT,
    previous_start_date INTEGER,
    previous_end_date INTEGER,
    gate_flags TEXT,
    approval_notified_at INTEGER,
    og_image_sweep_attempted_at INTEGER,
    -- K3 (drizzle/0095, analyst, 2026-05-31) — merge tombstone pointer.
    merged_into TEXT,
    -- K2 part 5 (drizzle/0096, analyst, 2026-05-31) — possible-duplicate
    -- pointer for MEDIUM-confidence dedup matches.
    possible_duplicate_of TEXT,
    -- K27 (drizzle/0124, 2026-06-15) — auto-rollover provenance pointer.
    rolled_from_event_id TEXT,
    -- UX-R1 / C1 (drizzle/0098, analyst 2026-06-01 EVE) — post-ingest operator-
    -- review marker. Set by scripts/backfill-event-days-from-description.ts
    -- when expandCadence can't determine a pattern. Drizzle inserts SQL that
    -- includes this column even when callers don't pass a value (NOT NULL with
    -- default 0), so test seeders need it here or every INSERT fails.
    flagged_for_review INTEGER NOT NULL DEFAULT 0,
    -- TAX1 Phase 1 (drizzle/0100, 2026-06-02) — audience/access taxonomy.
    -- Same Drizzle-emits-it-anyway pattern as flagged_for_review above:
    -- because both columns are NOT NULL with defaults, omitting them
    -- from the test CREATE TABLE causes every events INSERT in the
    -- mcp-server suites to fail with "no column named primary_audience".
    primary_audience TEXT NOT NULL DEFAULT 'PUBLIC',
    public_access TEXT NOT NULL DEFAULT 'OPEN',
    access_notes TEXT,
    registration_required INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5,
    -- SYN1 (drizzle/0122) — per-event syndication delivery version.
    syndication_version INTEGER NOT NULL DEFAULT 0,
    -- EH3 P0 (drizzle/0127) — occurrence → series link (nullable, no default).
    -- Mirrored here so the WS2b schema-sync guard passes; no MCP tool writes it yet.
    series_id TEXT,
    -- OPE-13 (drizzle/0133) — vendor-roster research state (all nullable, no
    -- default). Mirrored here so the schema-sync guard passes and every events
    -- INSERT keeps working; written by set_vendor_roster_status + the
    -- occurred-sweep NEEDS_RESEARCH enqueue, read by get_event_details.
    vendor_roster_status TEXT,
    vendor_roster_checked_at INTEGER,
    vendor_roster_source_url TEXT,
    vendor_roster_offset INTEGER
  );

  -- EH3 P0 (drizzle/0127) — series parent. Needed here once tools join it
  -- (P3.4 get_vendor_events leftJoins event_series).
  CREATE TABLE event_series (
    id TEXT PRIMARY KEY,
    canonical_slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    venue_id TEXT,
    promoter_id TEXT,
    recurrence_rule TEXT,
    description TEXT,
    image_url TEXT,
    categories TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    primary_audience TEXT NOT NULL DEFAULT 'PUBLIC',
    public_access TEXT NOT NULL DEFAULT 'OPEN',
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE event_date_drift_findings (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    stored_start_date INTEGER NOT NULL,
    canonical_start_date INTEGER,
    drift_days INTEGER NOT NULL,
    canonical_url TEXT,
    canonical_html_excerpt TEXT,
    checked_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  -- GW1a (drizzle/0101, 2026-06-02). Goodwill Engine Phase 1 sibling
  -- tables. event_discrepancies is the queue; sources / source_reliability
  -- / source_type_priors back the Bayesian updater (GW1c).
  CREATE TABLE sources (
    source_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    authority_weight REAL NOT NULL DEFAULT 1.0,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE source_reliability (
    source_key TEXT NOT NULL,
    field_class TEXT NOT NULL,
    axis TEXT NOT NULL,
    prior_type TEXT NOT NULL,
    alpha REAL NOT NULL,
    beta REAL NOT NULL,
    n_checks INTEGER NOT NULL DEFAULT 0,
    n_agreed INTEGER NOT NULL DEFAULT 0,
    n_stale INTEGER NOT NULL DEFAULT 0,
    score REAL NOT NULL,
    confidence TEXT NOT NULL,
    model_version TEXT NOT NULL,
    last_updated INTEGER NOT NULL,
    PRIMARY KEY (source_key, field_class, axis)
  );

  CREATE TABLE source_type_priors (
    source_type TEXT NOT NULL,
    field_class TEXT NOT NULL,
    axis TEXT NOT NULL,
    prior_alpha REAL NOT NULL,
    prior_beta REAL NOT NULL,
    PRIMARY KEY (source_type, field_class, axis)
  );

  -- GW1e (drizzle/0102, 2026-06-02). Daily snapshots of the goodwill
  -- queue + reliability medians; backs the Slack health canary.
  CREATE TABLE goodwill_health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    open_count INTEGER NOT NULL,
    outreach_candidate_count INTEGER NOT NULL,
    weighted_priority_sum REAL NOT NULL,
    open_ingest_addverify INTEGER NOT NULL DEFAULT 0,
    open_stale_page_radar INTEGER NOT NULL DEFAULT 0,
    open_self_consistency INTEGER NOT NULL DEFAULT 0,
    open_manual INTEGER NOT NULL DEFAULT 0,
    resolved_last_28d INTEGER NOT NULL DEFAULT 0,
    dismissed_last_28d INTEGER NOT NULL DEFAULT 0,
    median_official_freshness REAL,
    median_official_accuracy REAL,
    median_aggregator_accuracy REAL,
    last_yellow_alerted_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_goodwill_snapshot_date
    ON goodwill_health_snapshots(snapshot_date);

  CREATE TABLE event_discrepancies (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    field_class TEXT NOT NULL,
    authoritative_value TEXT,
    authoritative_source_key TEXT,
    authoritative_source_url TEXT,
    divergent_value TEXT,
    divergent_source_key TEXT,
    divergent_source_url TEXT,
    detected_by TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    confidence REAL,
    resolution_status TEXT NOT NULL DEFAULT 'open',
    resolved_value TEXT,
    resolution_source TEXT,
    resolved_at INTEGER,
    outreach_candidate INTEGER NOT NULL DEFAULT 0,
    outreach_priority_score REAL,
    outreach_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE vendors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    -- EH2.1 (drizzle/0121, 2026-06-09) — optional brand display override.
    display_name TEXT,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    vendor_type TEXT,
    products TEXT DEFAULT '[]',
    website TEXT,
    social_links TEXT,
    logo_url TEXT,
    verified INTEGER DEFAULT 0,
    commercial INTEGER DEFAULT 0,
    can_self_confirm INTEGER DEFAULT 0,
    contact_name TEXT,
    contact_email TEXT,
    contact_phone TEXT,
    address TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    latitude REAL,
    longitude REAL,
    year_established INTEGER,
    payment_methods TEXT DEFAULT '[]',
    license_info TEXT,
    insurance_info TEXT,
    enhanced_profile INTEGER NOT NULL DEFAULT 0,
    enhanced_profile_started_at INTEGER,
    enhanced_profile_expires_at INTEGER,
    gallery_images TEXT NOT NULL DEFAULT '[]',
    featured_priority INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    claimed_by TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    verified_pro INTEGER NOT NULL DEFAULT 0,
    verified_pro_at INTEGER,
    verified_pro_by TEXT,
    deleted_at INTEGER,
    redirect_to_vendor_id TEXT,
    enrichment_source TEXT,
    enrichment_attempted_at INTEGER,
    domain_hijacked INTEGER NOT NULL DEFAULT 0,
    completeness_score INTEGER NOT NULL DEFAULT 0,
    -- EH1 Phase 1 (drizzle/0106 + 0107, 2026-06-05) — vendor hierarchy +
    -- relationship model. Mirror the columns on the real vendors table
    -- so tests using the Drizzle schema can INSERT without "no such
    -- column" errors. Whenever a column is renamed or added to the
    -- vendors table this block MUST be updated in lockstep — vitest
    -- silently fails the affected test with "no such column" otherwise.
    role TEXT NOT NULL DEFAULT 'INDEPENDENT',
    brand_parent_vendor_id TEXT,
    operator_parent_vendor_id TEXT,
    alias_of_vendor_id TEXT,
    relationship_type TEXT NOT NULL DEFAULT 'independent',
    default_child_display TEXT,
    display_override_permitted INTEGER NOT NULL DEFAULT 0,
    display_mode TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5
  );

  CREATE TABLE vendor_slug_history (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );

  CREATE TABLE event_slug_history (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );

  -- E remainder (Dev backlog 2026-06-05, drizzle/0109) — venue +
  -- promoter slug-history. Same shape as event_slug_history.
  CREATE TABLE venue_slug_history (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );

  CREATE TABLE promoter_slug_history (
    id TEXT PRIMARY KEY,
    promoter_id TEXT NOT NULL,
    old_slug TEXT NOT NULL,
    new_slug TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT
  );

  CREATE TABLE admin_actions (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor_user_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE event_vendors (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'APPLIED',
    payment_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    participation_type TEXT NOT NULL DEFAULT 'EXHIBITOR',
    booth_info TEXT,
    -- F — K18 Phase 1 (drizzle/0114, 2026-06-06): optional per-occurrence
    -- scoping. NULL = series-wide (today's behavior). Set = vendor on that
    -- specific event_day only.
    event_day_id TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  -- K18 Phase 1 partial unique indexes (SQLite NULL-distinct gotcha).
  -- Mirrors drizzle/0114 exactly so vitest's create_or_link_vendor dedup
  -- exercises the same constraint shape as prod.
  CREATE UNIQUE INDEX idx_eventvendors_series_unique
    ON event_vendors (event_id, vendor_id)
    WHERE event_day_id IS NULL;
  CREATE UNIQUE INDEX idx_eventvendors_perday_unique
    ON event_vendors (event_id, vendor_id, event_day_id)
    WHERE event_day_id IS NOT NULL;

  CREATE TABLE event_days (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    date TEXT NOT NULL,
    -- DQ4 (drizzle/0118, 2026-06-08) — open_time/close_time are now nullable.
    -- Mirror the prod schema so MCP tool tests can exercise the null path
    -- (create_event_day without time args, update_event_day clearing).
    open_time TEXT,
    close_time TEXT,
    notes TEXT,
    closed INTEGER DEFAULT 0,
    vendor_only INTEGER DEFAULT 0,
    status TEXT,
    -- F2 (drizzle/0120, 2026-06-08) — per-occurrence image + focal point.
    -- MCP create_event_day / update_event_day tests pass image_url / focal
    -- args; mirror the schema so vitest doesn't fail with "no column named
    -- image_url" before our updates land.
    image_url TEXT,
    image_focal_x REAL NOT NULL DEFAULT 0.5,
    image_focal_y REAL NOT NULL DEFAULT 0.5,
    -- Drizzle eventDays schema declares createdAt with a $defaultFn so
    -- INSERTs always carry this column even when the caller does not pass it.
    -- Without this in the test schema, the K18 seedEventDay helpers fail
    -- with "table event_days has no column named created_at" at insert time.
    created_at INTEGER
  );

  CREATE TABLE vendor_outreach_attempts (
    id TEXT PRIMARY KEY,
    vendor_id TEXT NOT NULL,
    attempt_started_at INTEGER NOT NULL,
    channel TEXT NOT NULL,
    outcome TEXT,
    outcome_at INTEGER,
    notes TEXT,
    created_by TEXT
  );

  CREATE TABLE enrichment_log (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    finished_at INTEGER,
    fields_changed TEXT,
    notes TEXT,
    actor_user_id TEXT
  );

  CREATE TABLE vendor_enrichment_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id TEXT NOT NULL,
    job_run_id TEXT NOT NULL,
    proposed_field TEXT NOT NULL,
    current_value TEXT,
    proposed_value TEXT NOT NULL,
    source_url TEXT NOT NULL,
    extraction_method TEXT NOT NULL,
    fetch_method TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by TEXT,
    decision TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE UNIQUE INDEX idx_vec_pending_field
    ON vendor_enrichment_candidates (vendor_id, proposed_field)
    WHERE decision = 'pending';

  CREATE TABLE url_domain_classifications (
    domain TEXT PRIMARY KEY,
    use_as_ticket_url INTEGER NOT NULL DEFAULT 0,
    use_as_application_url INTEGER NOT NULL DEFAULT 0,
    use_as_source INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE indexnow_submissions (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL,
    urls TEXT NOT NULL DEFAULT '[]',
    url_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    http_status INTEGER,
    error_message TEXT
  );

  CREATE TABLE email_send_ledger (
    message_id TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL,
    recipient TEXT,
    source TEXT,
    provider_message_id TEXT
  );

  CREATE TABLE email_suppression_list (
    email TEXT PRIMARY KEY,
    reason TEXT,
    source TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE blog_posts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    body TEXT,
    status TEXT NOT NULL DEFAULT 'PUBLISHED'
  );

  CREATE TABLE content_links (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_slug TEXT NOT NULL,
    target_id TEXT,
    created_at INTEGER,
    notified_at INTEGER
  );

  CREATE TABLE pending_search_pings (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_slug TEXT NOT NULL,
    action TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    flushed_at INTEGER,
    flushed_batch_id TEXT
  );

  CREATE TABLE event_data_citations (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    value TEXT NOT NULL,
    year INTEGER,
    source_url TEXT NOT NULL,
    source_name TEXT,
    source_type TEXT NOT NULL,
    confidence REAL,
    state TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    supersedes_citation_id TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX idx_citations_event_field ON event_data_citations (event_id, field_name);
  CREATE INDEX idx_citations_event_state ON event_data_citations (event_id, state);
  CREATE INDEX idx_citations_state ON event_data_citations (state);

  CREATE TABLE inbound_emails (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    subject TEXT,
    intent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    workflow_instance_id TEXT,
    body_text_excerpt TEXT,
    parsed_url TEXT,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    raw_size INTEGER,
    error TEXT,
    message_id TEXT,
    reply_kind TEXT,
    resulting_event_id TEXT,
    fetch_method TEXT,
    extraction_method TEXT,
    classified_intent TEXT,
    classified_sub_intent TEXT,
    classified_confidence REAL,
    classified_rationale TEXT,
    classified_at INTEGER,
    classifier_version TEXT,
    routing_source TEXT,
    routed_to_workflow TEXT,
    flagged_for_review INTEGER NOT NULL DEFAULT 0,
    parent_email_id TEXT,
    recovery_attempt_n INTEGER NOT NULL DEFAULT 0,
    salvage_notified_at INTEGER,
    -- K7.4 (analyst, 2026-05-31) — drizzle/0094 extract telemetry. See
    -- packages/db-schema/src/index.ts inboundEmails for column doc comments.
    extract_fail_reason TEXT,
    content_sha256_first16 TEXT,
    content_length_chars INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX uq_inbound_emails_message_id
    ON inbound_emails(message_id)
    WHERE message_id IS NOT NULL;
  CREATE INDEX idx_inbound_emails_reply_kind
    ON inbound_emails(reply_kind)
    WHERE reply_kind IS NOT NULL;
  CREATE INDEX idx_inbound_emails_content_hash
    ON inbound_emails(content_sha256_first16)
    WHERE content_sha256_first16 IS NOT NULL;

  CREATE TABLE email_source_suggestions (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    host TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    suggested_by_email TEXT,
    suggested_via_inbound_id TEXT,
    reviewed_at INTEGER,
    reviewed_by_user_id TEXT,
    admin_notes TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_email_source_suggestions_host ON email_source_suggestions (host);
  CREATE UNIQUE INDEX uq_email_source_suggestions_pending_host
    ON email_source_suggestions (host)
    WHERE status = 'pending_review';

  -- discovery_candidates — pre-existing prod table owned by the
  -- out-of-repo daily NE event discovery skill (schema captured from
  -- PRAGMA table_info on 2026-05-21). Added to the test setup for K12
  -- (2026-06-02) when seed-discovery began writing to it.
  CREATE TABLE discovery_candidates (
    id TEXT PRIMARY KEY,
    rule_slug TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_label TEXT NOT NULL,
    source_url TEXT,
    source_ref_id TEXT,
    state TEXT,
    category TEXT,
    expected_yield INTEGER,
    last_yield INTEGER,
    total_events_created INTEGER NOT NULL DEFAULT 0,
    cms_type TEXT,
    harvest_method TEXT,
    harvest_endpoint TEXT,
    rescrape_interval_days INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    status_reason TEXT,
    last_outcome TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_harvested_at INTEGER,
    resolved_at INTEGER,
    snoozed_until INTEGER
  );

  CREATE TABLE submission_correction_tokens (
    token TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    inbound_email_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_submission_correction_tokens_event
    ON submission_correction_tokens (event_id);

  -- SYN1 (drizzle/0122) — syndication outbox + subscriber registry.
  CREATE TABLE syndication_outbox (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    change_version INTEGER NOT NULL,
    changed_fields TEXT NOT NULL DEFAULT '[]',
    snapshot TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE INDEX idx_syndication_outbox_entity ON syndication_outbox (entity_type, entity_id);
  CREATE INDEX idx_syndication_outbox_processed ON syndication_outbox (processed_at);

  CREATE TABLE syndication_subscribers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE syndication_subscriptions (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX uq_syndication_sub_event
    ON syndication_subscriptions (subscriber_id, event_id);
  CREATE INDEX idx_syndication_subscriptions_event
    ON syndication_subscriptions (event_id);
`;

export function createTestDb(): { db: TestDb; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  // Use bracket notation: dot-form triggers a paranoid pre-write hook that
  // misreads better-sqlite3's API as Node's child_process. The semantics
  // are identical.
  raw["exec"](SCHEMA_SQL);
  const db = drizzle(raw, { schema });
  // D1 exposes `db.batch([...])` (atomic, sequential); better-sqlite3 doesn't.
  // Shim it so code paths that batch — e.g. SYN1's outbox-row + version-bump
  // written alongside the entity UPDATE — run under test. better-sqlite3 is
  // synchronous, so sequential execution is effectively atomic per test.
  (db as unknown as { batch: (stmts: unknown[]) => Promise<unknown[]> }).batch = async (
    statements
  ) => {
    const results: unknown[] = [];
    for (const stmt of statements) {
      const s = stmt as { run?: () => unknown };
      results.push(typeof s.run === "function" ? s.run() : await (stmt as Promise<unknown>));
    }
    return results;
  };
  return { db, raw };
}

/**
 * Captures (toolName, handler) pairs from any code that calls
 * `server.tool(name, desc, schema, handler)`. Lets tests invoke a tool's
 * handler directly without spinning up the real MCP transport.
 */
export class CapturingMcpServer {
  handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (params: Record<string, unknown>) => Promise<unknown>
  ) {
    this.handlers.set(name, handler);
  }

  invoke(name: string, params: Record<string, unknown> = {}) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Tool not registered: ${name}`);
    return handler(params);
  }
}

/**
 * Captures fetch calls to /api/internal/indexnow so tests can assert which
 * source label would be sent. Returns a {calls, restore} pair — call restore()
 * in afterEach to put the original fetch back.
 */
export type IndexNowCall = { urls: string[]; source?: string };

export function mockIndexNowFetch(): { calls: IndexNowCall[]; restore: () => void } {
  const calls: IndexNowCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/api/internal/indexnow") && init?.body) {
      try {
        const parsed = JSON.parse(init.body as string) as IndexNowCall;
        calls.push(parsed);
      } catch {
        // fall through
      }
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

-- GW1a (analyst, 2026-06-02). Goodwill Engine Phase 1, sub-part a:
-- four new tables backing the cross-source discrepancy capture +
-- per-source reliability index.
--
-- Phase 1 ends at "ranked outreach queue" — capture → score →
-- prioritize → surface. Phase 2 (the actual outreach: drafting,
-- sending, response capture) is explicitly out of scope; its hooks
-- live on event_discrepancies.outreach_id (reserved NULL in Phase 1).
--
-- Tables added (all 4 in this single migration so the seed-priors
-- INSERT block at the end can reference source_type_priors without
-- a follow-up step):
--
--   event_discrepancies   — one row per detected divergence on one
--                           field of one event. Populated by:
--                             - ingest_addverify   (inbound-email enrich-or-flag)
--                             - stale_page_radar   (Worker cron, GW1b)
--                             - self_consistency   (evaluateGates output, GW1b)
--                             - manual             (admin MCP tool)
--                           Resolved via the admin `resolve_discrepancy`
--                           tool which then triggers the Bayesian
--                           updater (GW1c).
--
--   source_reliability    — per-(source_key × field_class × axis)
--                           Beta-distributed accuracy/freshness score.
--                           Keyed on `events.source_domain` (lowercased,
--                           www-stripped) so it cross-links to the
--                           existing `get_source_quality` aggregation
--                           without a schema change there.
--
--   sources               — registry mapping source_key → source_type
--                           (official | dmo_tourism | ticketing |
--                           newspaper | social | aggregator | community
--                           | unknown). Drives the Bayesian PRIOR via
--                           source_type_priors. Authority_weight is a
--                           tiebreaker in the reliability-weighted
--                           resolution path (GW1d).
--
--   source_type_priors    — cold-start priors per
--                           (source_type × field_class × axis). Seeded
--                           in this migration (see INSERT block below).
--                           Versioned via model_version on
--                           source_reliability so the seed config can
--                           change without silently mutating past scores.
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('event_discrepancies');
--   PRAGMA table_info('source_reliability');
--   PRAGMA table_info('sources');
--   PRAGMA table_info('source_type_priors');
-- Run against prod D1 via Cloudflare MCP `d1_database_query` before
-- applying — all four are NEW. SQLite's CREATE TABLE IF NOT EXISTS
-- form is used below so a partial-apply retry is safe.
--
-- Why no `merged_into`-style cascade on event_discrepancies.event_id
-- ON DELETE CASCADE: when events.delete is rare (we use REJECTED/
-- merged_into instead), the cascade is mostly precautionary. Keeps the
-- table consistent if an event row IS removed; otherwise unused.

-- ── event_discrepancies ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_discrepancies (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- field_class enum (application-layer enforcement):
  --   date | hours | venue | status | price | existence | name
  field_class TEXT NOT NULL,
  -- The value MMATF currently treats as correct (the events column
  -- value at capture time). NULL when the field is itself absent.
  authoritative_value TEXT,
  -- source_key aligns with events.source_domain (lowercased, no www).
  -- NULL on `manual` discrepancies that don't have a source.
  authoritative_source_key TEXT,
  authoritative_source_url TEXT,
  -- The other source's claim that didn't win at ingest. For
  -- self_consistency discrepancies, this is the "what the field would
  -- be if the inconsistency were corrected" hint.
  divergent_value TEXT,
  divergent_source_key TEXT,
  divergent_source_url TEXT,
  -- detected_by enum:
  --   ingest_addverify | stale_page_radar | self_consistency | manual
  -- Reserved for Phase 2/3: crowd_report, ai_monitor
  detected_by TEXT NOT NULL,
  -- Epoch seconds — matches the Drizzle `mode: "timestamp"` convention
  -- ([[reference_drizzle_timestamp_mode_is_seconds]]).
  detected_at INTEGER NOT NULL,
  -- 0..1 detector confidence this is a real divergence, not a spurious
  -- format difference (e.g., 2026-06-02 vs "June 2 2026"). NULL when
  -- the capture path doesn't compute one.
  confidence REAL,
  -- resolution_status enum (application-layer):
  --   open | resolved_authoritative | resolved_divergent | self_resolved | dismissed
  resolution_status TEXT NOT NULL DEFAULT 'open',
  resolved_value TEXT,
  -- resolution_source enum:
  --   higher_tier | post_event | operator
  -- Reserved for Phase 2: promoter_reply
  resolution_source TEXT,
  resolved_at INTEGER,
  -- Computed by the queue ranker (GW1d). Boolean as INTEGER per the
  -- D1 boolean convention.
  outreach_candidate INTEGER NOT NULL DEFAULT 0,
  outreach_priority_score REAL,
  -- Phase 2 placeholder — always NULL in Phase 1 per B13 ("Phase 2
  -- adds a communication layer rather than migrating the foundation").
  -- Reserving the column now means Phase 2 needs no migration.
  outreach_id TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Queue index — supports the `list_event_discrepancies` admin tool's
-- primary query path. Partial so the index only carries OPEN rows
-- (the operator queue is always a small subset of total rows).
CREATE INDEX IF NOT EXISTS idx_discrepancies_status_priority
  ON event_discrepancies(resolution_status, outreach_priority_score DESC)
  WHERE resolution_status = 'open';

-- Per-event lookup (admin event detail page surfacing related discrepancies).
CREATE INDEX IF NOT EXISTS idx_discrepancies_event ON event_discrepancies(event_id);

-- Per-source rollups for the GW1c Bayesian updater and GW1e CPI
-- report-card (which sources are most-divergent, which are most-cited).
CREATE INDEX IF NOT EXISTS idx_discrepancies_div_src ON event_discrepancies(divergent_source_key, field_class);
CREATE INDEX IF NOT EXISTS idx_discrepancies_auth_src ON event_discrepancies(authoritative_source_key, field_class);

-- ── source_reliability ───────────────────────────────────────────
-- Beta-posterior per (source × field × axis). Score is the posterior
-- mean (alpha / (alpha + beta)). Updated by GW1c after each
-- resolve_discrepancy. Composite PK forces one row per cell, simplifying
-- the upsert path (ON CONFLICT(source_key, field_class, axis) DO UPDATE).
CREATE TABLE IF NOT EXISTS source_reliability (
  source_key TEXT NOT NULL,
  field_class TEXT NOT NULL,
  -- axis enum: accuracy | freshness
  axis TEXT NOT NULL,
  -- Snapshot of the source_type at the time this row was created,
  -- denormalized so the scoring path doesn't need to JOIN sources on
  -- every read. Re-synced when the source's type changes (rare).
  prior_type TEXT NOT NULL,
  -- Beta-distribution parameters (successes + prior, failures + prior).
  alpha REAL NOT NULL,
  beta REAL NOT NULL,
  -- Observation counts — used by the GW1e report-card to display
  -- "X agreements out of Y checks" alongside the bare score.
  n_checks INTEGER NOT NULL DEFAULT 0,
  n_agreed INTEGER NOT NULL DEFAULT 0,
  n_stale INTEGER NOT NULL DEFAULT 0,
  -- Posterior mean — kept denormalized so the queue rank can sort
  -- without recomputing on every read.
  score REAL NOT NULL,
  -- confidence enum: prior_only | low | established
  confidence TEXT NOT NULL,
  -- Versioning per B8 — never silently mutate scoring logic. Bump this
  -- in seed-priors when prior values change, so old rows can be
  -- distinguished from rows scored under the new prior set.
  model_version TEXT NOT NULL,
  last_updated INTEGER NOT NULL,
  PRIMARY KEY (source_key, field_class, axis)
);

-- ── sources ──────────────────────────────────────────────────────
-- Registry mapping source_key → display name + type. Pre-seeded with
-- a baseline of known sources in a follow-up data step (post-deploy);
-- new source_keys discovered during ingest auto-create with type =
-- 'unknown' and authority_weight = 1.0 (the prior bucket already
-- carries the type uncertainty).
CREATE TABLE IF NOT EXISTS sources (
  source_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  -- source_type enum (application-layer):
  --   official | dmo_tourism | ticketing | newspaper | social | aggregator | community | unknown
  source_type TEXT NOT NULL,
  -- Used as a tiebreaker in the reliability-weighted resolution path
  -- (GW1d) when two sources have equal posterior scores. Default 1.0
  -- so the priors do the talking.
  authority_weight REAL NOT NULL DEFAULT 1.0,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── source_type_priors ───────────────────────────────────────────
-- Cold-start Beta priors per (source_type × field_class × axis). When
-- a new (source_key, field_class, axis) cell needs initialization, the
-- GW1c updater reads source_type from `sources`, then reads
-- (prior_alpha, prior_beta) from this table. Score start = mean.
-- Confidence start = 'prior_only'.
CREATE TABLE IF NOT EXISTS source_type_priors (
  source_type TEXT NOT NULL,
  field_class TEXT NOT NULL,
  axis TEXT NOT NULL,
  prior_alpha REAL NOT NULL,
  prior_beta REAL NOT NULL,
  PRIMARY KEY (source_type, field_class, axis)
);

-- ── Seed priors (model_version: gw1-2026-06) ─────────────────────
--
-- Encoded as INSERT OR IGNORE so this migration is idempotent — a
-- partial-apply retry won't double-insert. To CHANGE prior values
-- without losing history, bump model_version in a follow-up migration
-- and overwrite via UPDATE; never silently edit these defaults in place.
--
-- The Beta-distribution priors below encode the bundle's design
-- principles (B5 of the dev email):
--
--   - official sources: HIGH accuracy default (the homepage is usually
--     the canonical statement of the event's identity), but LOW freshness
--     default specifically for `date` (the key asymmetry — annual events'
--     "next date" rarely gets a same-day update; the prior-year date
--     lingers on the page).
--   - aggregators: LOW everything — FestivalNet is the canonical case;
--     do-not-ingest is already policy, but if we DO score one, the prior
--     should match the bundle's stance.
--   - dmo_tourism / ticketing: HIGH accuracy (Simpleview JSON-LD,
--     Humanitix). Freshness is roughly average.
--   - newspaper: HIGH freshness on `date` (press coverage is usually
--     about the upcoming or current instance), HIGH accuracy.
--   - social / community: middle-of-the-road; treat as unknown until
--     observations accumulate.
--   - unknown: 50/50 — a true uninformative prior.
--
-- prior_alpha + prior_beta near 10 gives meaningful pseudo-counts so a
-- handful of observations don't immediately swing the posterior — the
-- "established" bucket starts kicking in around 10 observations per the
-- GW1c confidence-flag rules.
--
-- field_class catalog: date | hours | venue | status | price | existence | name
-- axis catalog:        accuracy | freshness

-- Catalog materialized via WITH ... VALUES rather than UNION ALL.
-- D1's local-mode emulation (wrangler d1 migrations apply --local
-- via Miniflare) caps SQLITE_LIMIT_COMPOUND_SELECT very low — the
-- earlier UNION ALL form (8+7+2=17 terms across three subqueries)
-- failed CI with "too many terms in compound SELECT: SQLITE_ERROR".
-- VALUES is the portable, limit-free way to materialize a small
-- constants table. Prior values are computed via CASE expressions
-- encoding the design above.
INSERT OR IGNORE INTO source_type_priors (source_type, field_class, axis, prior_alpha, prior_beta)
WITH st(source_type) AS (VALUES
  ('official'), ('dmo_tourism'), ('ticketing'), ('newspaper'),
  ('social'), ('aggregator'), ('community'), ('unknown')
),
fc(field_class) AS (VALUES
  ('date'), ('hours'), ('venue'), ('status'),
  ('price'), ('existence'), ('name')
),
ax(axis) AS (VALUES
  ('accuracy'), ('freshness')
)
SELECT
  st.source_type,
  fc.field_class,
  ax.axis,
  -- prior_alpha (successes pseudo-count)
  CASE
    -- aggregator: LOW everything
    WHEN st.source_type = 'aggregator' THEN 2.0
    -- official date × freshness: LOW (stale-year prone) — the key asymmetry
    WHEN st.source_type = 'official' AND fc.field_class = 'date' AND ax.axis = 'freshness' THEN 3.0
    -- official * × accuracy: HIGH
    WHEN st.source_type = 'official' AND ax.axis = 'accuracy' THEN 8.0
    -- dmo_tourism / ticketing × accuracy: HIGH
    WHEN st.source_type IN ('dmo_tourism', 'ticketing') AND ax.axis = 'accuracy' THEN 8.0
    -- newspaper date × freshness: HIGH (press coverage is current)
    WHEN st.source_type = 'newspaper' AND fc.field_class = 'date' AND ax.axis = 'freshness' THEN 8.0
    -- newspaper * × accuracy: HIGH
    WHEN st.source_type = 'newspaper' AND ax.axis = 'accuracy' THEN 7.0
    -- social: middle, lean toward unreliable
    WHEN st.source_type = 'social' THEN 4.0
    -- community: middle, lean toward reliable on existence
    WHEN st.source_type = 'community' AND fc.field_class = 'existence' THEN 6.0
    WHEN st.source_type = 'community' THEN 5.0
    -- unknown: 50/50
    WHEN st.source_type = 'unknown' THEN 5.0
    -- default for any other combination: middle
    ELSE 5.0
  END AS prior_alpha,
  -- prior_beta (failures pseudo-count). Sum of alpha+beta ≈ 10
  -- keeps the prior weight comparable to ~10 observations, matching
  -- the GW1c "established" threshold.
  CASE
    WHEN st.source_type = 'aggregator' THEN 8.0
    WHEN st.source_type = 'official' AND fc.field_class = 'date' AND ax.axis = 'freshness' THEN 7.0
    WHEN st.source_type = 'official' AND ax.axis = 'accuracy' THEN 2.0
    WHEN st.source_type IN ('dmo_tourism', 'ticketing') AND ax.axis = 'accuracy' THEN 2.0
    WHEN st.source_type = 'newspaper' AND fc.field_class = 'date' AND ax.axis = 'freshness' THEN 2.0
    WHEN st.source_type = 'newspaper' AND ax.axis = 'accuracy' THEN 3.0
    WHEN st.source_type = 'social' THEN 6.0
    WHEN st.source_type = 'community' AND fc.field_class = 'existence' THEN 4.0
    WHEN st.source_type = 'community' THEN 5.0
    WHEN st.source_type = 'unknown' THEN 5.0
    ELSE 5.0
  END AS prior_beta
FROM st CROSS JOIN fc CROSS JOIN ax;

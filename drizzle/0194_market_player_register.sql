-- OPE-414 — market-player register.
--
-- A queryable home for landscape intel that currently lives as prose in session
-- notes. Three tables: who the players are, what we measured about them over
-- time, and where they rank.
--
-- ---------------------------------------------------------------------------
-- Why `market_players` and not `competitors`
-- ---------------------------------------------------------------------------
--
-- This is a correctness decision, not a naming preference, and it came from
-- John directly.
--
-- visitmaine.com, downtownbangor.com and maine.gov list the same events we do.
-- They are also a state tourism board, a downtown partnership, and a state
-- government — civic bodies whose interest in those events is the opposite of
-- competitive. They are the most valuable CITATION SOURCES and PARTNERS
-- available to us. A table named `competitors` would have asserted the reverse
-- about every row in it, silently, and every future reader would have inherited
-- that framing without ever seeing the decision that produced it.
--
-- So each row carries two orthogonal axes, and they are deliberately NOT
-- collapsed into one:
--
--   org_class    — what the organization IS    (for_profit / nonprofit /
--                                               government / individual)
--   relationship — what it is TO US            (competitor / aggregator /
--                                               partner / citation_source)
--
-- Collapsing them loses real cases: a for-profit aggregator can be one we are
-- happy to syndicate into, and a nonprofit can still take the search result we
-- want. One field cannot say both.
--
-- ---------------------------------------------------------------------------
-- Why snapshots are append-only
-- ---------------------------------------------------------------------------
--
-- The register's whole purpose is the TREND — is this site growing into our
-- market or drifting out of it. Updating an event_count in place answers
-- "what is it now", which we could already get by looking at the site, and
-- destroys the only thing the table adds. So `market_player_snapshots` is
-- insert-only, one row per observation, and `market_player_serp_ranks` is
-- normalized per (query, market, observation) rather than a JSON blob per
-- player — so "who ranks for 'craft fairs in Bangor', across everyone, over
-- time" stays a plain query.
--
-- ---------------------------------------------------------------------------
-- NULL is a real value in three places here
-- ---------------------------------------------------------------------------
--
--   has_schema / has_llms_txt  NULL = never checked · 0 = checked, absent.
--   serp_ranks.position        NULL = looked and did not find it in range,
--                              which is a genuine observation and NOT the same
--                              as "not checked" (no row at all).
--   snapshots.event_count      NULL = not countable on that visit.
--
-- A register that gets re-swept has to distinguish "unknown" from "known to be
-- zero", or the second sweep cannot tell what it still owes.
CREATE TABLE IF NOT EXISTS market_players (
  id              TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,
  name            TEXT,
  relationship    TEXT NOT NULL DEFAULT 'neutral',
  org_class       TEXT NOT NULL DEFAULT 'unknown',
  type            TEXT,
  geo_scope       TEXT,
  owner           TEXT,
  registered_at   INTEGER,
  business_model  TEXT,
  pricing         TEXT,
  tech_stack      TEXT,
  has_schema      INTEGER,
  has_llms_txt    INTEGER,
  threat_level    TEXT,
  threat_trend    TEXT,
  status          TEXT NOT NULL DEFAULT 'unknown',
  notes           TEXT,
  last_checked_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The upsert key. `upsert_market_player` is idempotent on domain, so a re-run
-- of the seed or of a monthly sweep updates in place instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_players_domain ON market_players(domain);
CREATE INDEX IF NOT EXISTS idx_market_players_relationship ON market_players(relationship);
CREATE INDEX IF NOT EXISTS idx_market_players_org_class ON market_players(org_class);
CREATE INDEX IF NOT EXISTS idx_market_players_threat ON market_players(threat_level);

CREATE TABLE IF NOT EXISTS market_player_snapshots (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL,
  event_count       INTEGER,
  ne_event_count    INTEGER,
  search_visibility REAL,
  notes             TEXT,
  source_url        TEXT,
  snapshot_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_player_snapshots_player
  ON market_player_snapshots(player_id, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_market_player_snapshots_at
  ON market_player_snapshots(snapshot_at);

CREATE TABLE IF NOT EXISTS market_player_serp_ranks (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL,
  query       TEXT NOT NULL,
  market      TEXT,
  position    INTEGER,
  ranking_url TEXT,
  checked_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_player_serp_player
  ON market_player_serp_ranks(player_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_market_player_serp_query
  ON market_player_serp_ranks(query, checked_at);

-- ---------------------------------------------------------------------------
-- Seed — only what is actually known
-- ---------------------------------------------------------------------------
--
-- The ticket points at MMATF-Analysis/Dev-Brief-2026-08-16-Competitor-Register-D1.md
-- for ~14 rows with their metrics. That file lives in the analyst's OneDrive
-- workspace on a different machine and is not readable from this runtime, so
-- the rows below are the ones the TICKET ITSELF names and characterizes.
--
-- Everything not stated in the ticket is left NULL rather than guessed. A
-- fabricated threat_level or event_count is indistinguishable from a measured
-- one the moment it lands here, and this register exists precisely to replace
-- prose with numbers somebody can trust. `upsert_market_player` is idempotent
-- on domain, so loading the full brief later updates these rows in place and
-- costs nothing.
--
-- The three civic rows are seeded FIRST and deliberately: they are the whole
-- reason the table is not called `competitors`, and having them present from
-- row one means the distinction is exercised rather than documented.
INSERT INTO market_players (id, domain, name, relationship, org_class, type, geo_scope, status, notes, created_at, updated_at)
VALUES
  ('mp-visitmaine',      'visitmaine.com',     'Visit Maine (Maine Office of Tourism)', 'citation_source', 'government', 'tourism board',       'ME', 'active',
   'Lists the same events we do, but as a state tourism body — a citation source and potential partner, never a competitor. Seeded from OPE-414 ticket text.', unixepoch(), unixepoch()),
  ('mp-downtownbangor',  'downtownbangor.com', 'Downtown Bangor Partnership',           'partner',         'nonprofit',  'downtown partnership','Bangor, ME', 'active',
   'Civic downtown partnership. Local-market thread (Bangor baseline). Seeded from OPE-414 ticket text.', unixepoch(), unixepoch()),
  ('mp-mainegov',        'maine.gov',          'State of Maine',                         'citation_source', 'government', 'government portal',   'ME', 'active',
   'State portal. Citation source. Seeded from OPE-414 ticket text.', unixepoch(), unixepoch()),
  ('mp-thecraftmap',     'thecraftmap.com',    'The Craft Map',                          'competitor',      'unknown',    'directory',           'national', 'unknown',
   'Named in OPE-414 as active competitive-monitoring subject. org_class/threat NOT set — not measured by this session.', unixepoch(), unixepoch()),
  ('mp-craftfairlist',   'craftfairlist.com',  'Craft Fair List',                        'competitor',      'unknown',    'directory',           'national', 'unknown',
   'Named in OPE-414 as active competitive-monitoring subject. org_class/threat NOT set — not measured by this session.', unixepoch(), unixepoch())
ON CONFLICT(domain) DO NOTHING;

-- The festivalsandfairs[state].com network is the subject of the OPE-393 epic
-- ("out-structure the festivalsandfairs[state].com network"), which is why it
-- is seeded as a competitor here. The per-state domains are enumerated in the
-- brief; only the pattern is asserted from the ticket, so one row stands for
-- the network until the brief is loaded.
INSERT INTO market_players (id, domain, name, relationship, org_class, type, geo_scope, status, notes, created_at, updated_at)
VALUES
  ('mp-festivalsandfairs', 'festivalsandfairs.com', 'festivalsandfairs[state].com network', 'competitor', 'for_profit', 'directory network', 'national', 'active',
   'Subject of the OPE-393 epic. Per-state domains are in the analyst brief (not readable from this runtime); this row stands for the network until they are loaded.', unixepoch(), unixepoch())
ON CONFLICT(domain) DO NOTHING;

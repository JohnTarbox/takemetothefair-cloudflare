-- OPE-1121 Phase 2 (13/13): market_player_serp_ranks gains its foreign key.
--
-- player_id → market_players(id) ON DELETE CASCADE.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references market_player_serp_ranks; checked against prod sqlite_master 2026-09-23, along with
-- 0 triggers and 0 views on it). Never a parent: D1 always enforces FKs, and
-- DROP TABLE on a parent runs an implicit DELETE that fires ON DELETE actions.
-- Orphans on the new FK column in prod, re-measured 2026-09-23: 0.
--
-- Failure safety does NOT rely on the file being atomic. wrangler sends this
-- file and its d1_migrations INSERT as ONE /query request (wrangler 4.131
-- buildMigrationQuery + executeRemotely); D1 documents batch() as a
-- transaction but says nothing either way for a multi-statement /query. So
-- every check that can fail — an orphan the INSERT rejects, the count check —
-- runs BEFORE the DROP of the original table. A failure there leaves the
-- original untouched, and the two DROP IF EXISTS lines below clear any
-- leftover scratch table, so a re-run starts clean.
--
-- NO `PRAGMA defer_foreign_keys`. The rehearsal (OPE-1121 PR) planted one
-- orphan and, WITH deferral, this rebuild copied it, declared the FK anyway,
-- and recorded the migration: the deferred check never fired. Deferral is not
-- needed here — no parent is touched — so the FK is checked row by row on the
-- INSERT, and the assertion below counts orphans explicitly as well, so a
-- failure does not depend on pragma semantics at all.

DROP TABLE IF EXISTS market_player_serp_ranks__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE market_player_serp_ranks__ope1121 (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES market_players(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  market TEXT,
  position INTEGER,
  ranking_url TEXT,
  checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO market_player_serp_ranks__ope1121 (id, player_id, query, market, position, ranking_url, checked_at, created_at)
SELECT id, player_id, query, market, position, ranking_url, checked_at, created_at FROM market_player_serp_ranks;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM market_player_serp_ranks__ope1121) = (SELECT count(*) FROM market_player_serp_ranks)
   AND (SELECT count(*) FROM market_player_serp_ranks__ope1121 c WHERE c.player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM market_players p WHERE p.id = c.player_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE market_player_serp_ranks;
ALTER TABLE market_player_serp_ranks__ope1121 RENAME TO market_player_serp_ranks;

CREATE INDEX idx_market_player_serp_player ON market_player_serp_ranks(player_id, checked_at);
CREATE INDEX idx_market_player_serp_query ON market_player_serp_ranks(query, checked_at);

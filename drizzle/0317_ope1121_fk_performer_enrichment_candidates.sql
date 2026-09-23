-- OPE-1121 Phase 2 (10/13): performer_enrichment_candidates gains its foreign key.
--
-- performer_id → performers(id) ON DELETE CASCADE.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references performer_enrichment_candidates; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS performer_enrichment_candidates__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE performer_enrichment_candidates__ope1121 (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  performer_id TEXT NOT NULL REFERENCES performers(id) ON DELETE CASCADE,
  job_run_id TEXT NOT NULL,
  proposed_field TEXT NOT NULL,
  current_value TEXT,
  proposed_value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  fetch_method TEXT,
  confidence REAL DEFAULT 0 NOT NULL,
  flags TEXT DEFAULT '[]' NOT NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  decision TEXT DEFAULT 'pending' NOT NULL
);

INSERT INTO performer_enrichment_candidates__ope1121 (id, performer_id, job_run_id, proposed_field, current_value, proposed_value, source_url, extraction_method, fetch_method, confidence, flags, created_at, reviewed_at, reviewed_by, decision)
SELECT id, performer_id, job_run_id, proposed_field, current_value, proposed_value, source_url, extraction_method, fetch_method, confidence, flags, created_at, reviewed_at, reviewed_by, decision FROM performer_enrichment_candidates;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM performer_enrichment_candidates__ope1121) = (SELECT count(*) FROM performer_enrichment_candidates)
   AND (SELECT count(*) FROM performer_enrichment_candidates__ope1121 c WHERE c.performer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM performers p WHERE p.id = c.performer_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE performer_enrichment_candidates;
ALTER TABLE performer_enrichment_candidates__ope1121 RENAME TO performer_enrichment_candidates;

CREATE INDEX idx_perf_ec_decision ON performer_enrichment_candidates (decision);
CREATE INDEX idx_perf_ec_job_run ON performer_enrichment_candidates (job_run_id);
CREATE UNIQUE INDEX idx_perf_ec_pending_field ON performer_enrichment_candidates (performer_id, proposed_field) WHERE decision = 'pending';
CREATE INDEX idx_perf_ec_performer ON performer_enrichment_candidates (performer_id);

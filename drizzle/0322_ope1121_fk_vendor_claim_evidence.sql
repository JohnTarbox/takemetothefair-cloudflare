-- OPE-1121 Phase 3 (2/2): vendor_claim_evidence gains its foreign key.
--
-- vendor_id → vendors(id) ON DELETE CASCADE. The MCP merge_vendor moves this row to the keeper first; the app-side merge (merge-operations.ts:514), the purge sweep and admin DELETE hard-delete the vendor without touching it, which is exactly how the single orphan John ruled deleted on 2026-09-23 (a8a09617) came to exist. CASCADE makes that outcome the schema's instead of an orphan's. SET NULL is impossible (NOT NULL) and NO ACTION would break those delete paths. user_id deliberately gets NO foreign key: OPE-237 (#791) documented it as 'NOT an FK to keep the row as an audit tombstone if the account goes' — the registrant id must survive the account, which SET NULL would erase and CASCADE would delete
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references vendor_claim_evidence; checked against prod sqlite_master 2026-09-23, along with
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

DROP TABLE IF EXISTS vendor_claim_evidence__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE vendor_claim_evidence__ope1121 (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  user_id TEXT,
  claimant_name TEXT,
  claimant_email TEXT,
  business_name TEXT NOT NULL,
  declared_website TEXT,
  signals TEXT NOT NULL DEFAULT '{}',
  corroboration TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  corroboration_detail TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  band TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
  reasons TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  assessed_at INTEGER,
  reviewed_at INTEGER,
  reviewed_by TEXT
);

INSERT INTO vendor_claim_evidence__ope1121 (id, vendor_id, user_id, claimant_name, claimant_email, business_name, declared_website, signals, corroboration, corroboration_detail, score, band, reasons, created_at, assessed_at, reviewed_at, reviewed_by)
SELECT id, vendor_id, user_id, claimant_name, claimant_email, business_name, declared_website, signals, corroboration, corroboration_detail, score, band, reasons, created_at, assessed_at, reviewed_at, reviewed_by FROM vendor_claim_evidence;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM vendor_claim_evidence__ope1121) = (SELECT count(*) FROM vendor_claim_evidence)
   AND (SELECT count(*) FROM vendor_claim_evidence__ope1121 c WHERE c.vendor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vendors p WHERE p.id = c.vendor_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE vendor_claim_evidence;
ALTER TABLE vendor_claim_evidence__ope1121 RENAME TO vendor_claim_evidence;

CREATE UNIQUE INDEX idx_vce_vendor ON vendor_claim_evidence (vendor_id);
CREATE INDEX idx_vce_band ON vendor_claim_evidence (band);
CREATE INDEX idx_vce_created ON vendor_claim_evidence (created_at);

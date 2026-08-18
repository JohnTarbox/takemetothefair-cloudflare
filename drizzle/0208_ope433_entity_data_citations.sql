-- OPE-433 scope 4 — provenance for `venues` and `event_days`.
--
-- `events` carries source_name / source_url / source_id / source_domain /
-- ingestion_method / last_synced_at / dates_confirmed, and `event_data_citations`
-- gives it field-level evidence. `venues` and `event_days` carry NONE of it.
--
-- The defects are not randomly distributed. Both logged F-14 (fabricated fact)
-- instances live in `event_days` — MDI's invented 10-5/10-4/10-3 hours against a
-- published flat 9-4, and the 09:00-18:00 rows OPE-411 found. 256 of 2,008 day
-- rows have no hours at all; 167 of 963 active venues have no address. What is
-- not attributed does not get audited, and what is not audited drifts.
--
-- ── Sibling table, not a generalised one — and why ───────────────────────
--
-- The ticket allows either: "generalise it to (entity_type, entity_id,
-- field_name, …) or add sibling tables."
--
-- Generalising `event_data_citations` means making `event_id` nullable and
-- adding an entity key, which puts all 72 existing references and 6 modules on
-- the hook — including `dates-confirmed-basis.ts`, the module OPE-433 scope 1
-- just wired the confidence flag to. A widening that silently changes what an
-- existing query counts is the enum-widening failure this project already has a
-- named lesson for, and the reward would be one fewer table.
--
-- So: same SHAPE, addressed by (entity_type, entity_id). Events keep their
-- table untouched. If the two are ever unified it can be done as a deliberate
-- migration with the consumers audited, rather than as a side effect of adding
-- venue provenance.
--
-- ⚠️ NOT backfilled. For rows whose source is unrecoverable, absence is the
-- correct record — inventing one would be a fresh F-14, which is the exact
-- failure this ticket exists to close.

CREATE TABLE IF NOT EXISTS entity_data_citations (
  id TEXT PRIMARY KEY,
  -- VENUE | EVENT_DAY. Deliberately not 'EVENT': events have their own table
  -- and duplicating them here would create two answers to one question.
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT,
  -- Same vocabulary as event_data_citations, so a reader learns one enum.
  source_type TEXT NOT NULL,
  confidence REAL,
  state TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_citations_entity
  ON entity_data_citations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_citations_field
  ON entity_data_citations(entity_type, entity_id, field_name);
CREATE INDEX IF NOT EXISTS idx_entity_citations_state
  ON entity_data_citations(state, created_at);

-- One active citation per (entity, field, source). A second source asserting
-- the same field is ALLOWED and is the point — coexisting active rows are how
-- "N sources agreed" is computed, exactly as in event_data_citations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_citations_unique_active
  ON entity_data_citations(entity_type, entity_id, field_name, source_url)
  WHERE state = 'active';

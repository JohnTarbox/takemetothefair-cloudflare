-- OPE-830 — a per-entity write history that can record a save NOT happening.
--
-- Two live "my profile won't save" reports in ten days could not be settled,
-- because nothing recorded what a save actually wrote. The nearest instrument,
-- `enrichment_log`, has two blind spots that this table exists to close:
--
--   1. It records SUCCESSES ONLY. A save rejected at the auth gate returns
--      before any logging, so "we have no record of a save" and "no save was
--      attempted" are the same observation. That ambiguity is what made
--      OPE-830 unanswerable.
--   2. Its `fields_changed` is `Object.keys(updateData)` — the fields PRESENT
--      in the payload, not the fields that CHANGED. On the specimen vendor it
--      is byte-identical across all 18 saves, and would be identical on a
--      no-op resubmit.
--
-- So: outcome is explicit, rejections are first-class, and `changes_json`
-- carries a real before/after diff computed against the stored row.
--
-- ⚠️ Deliberately NOT a replacement for `enrichment_log`. That table answers
-- "when was this entity last enriched, by which source" and feeds coverage
-- dashboards. This one answers "what did this save do". Different questions.
CREATE TABLE IF NOT EXISTS entity_write_log (
  id TEXT PRIMARY KEY,

  -- What was written to. `entity_type` mirrors enrichment_log.target_type
  -- ('vendor', 'event', 'promoter', 'performer') so the two can be joined.
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,

  -- Which surface produced the write: 'vendor_self', 'admin_ui', 'mcp', …
  -- Same vocabulary as enrichment_log.source.
  source TEXT NOT NULL,

  -- ⚠️ The column this table exists for.
  --   'applied'  — the write ran and changed at least one field
  --   'noop'     — the write ran and changed nothing (a resubmit)
  --   'rejected' — the write was refused before touching the row
  --
  -- 'noop' is separate from 'applied' on purpose: "saved, nothing to do" and
  -- "saved, here is what moved" are different facts, and collapsing them
  -- rebuilds the ambiguity this table was built to remove.
  outcome TEXT NOT NULL,

  -- Why a 'rejected' row was refused: 'email_unverified', 'validation',
  -- 'not_found', 'forbidden', 'role_gate'. NULL on applied/noop.
  reject_reason TEXT,

  -- [{field, before, after, truncated?}] — the real diff, computed by
  -- comparing the incoming payload against the stored row. Empty array on
  -- 'noop'. NULL on 'rejected' (nothing was compared — which is NOT the same
  -- as an empty diff, and must not read as one).
  changes_json TEXT,

  -- Who did it. NULL for unauthenticated or system writes.
  actor_user_id TEXT,

  created_at INTEGER NOT NULL
);

-- The lookup this table is for: "show me every save on this entity".
CREATE INDEX IF NOT EXISTS idx_entity_write_log_entity
  ON entity_write_log (entity_type, entity_id, created_at);

-- "Show me rejected saves in the last hour" — the sweep that would have
-- caught OPE-830 without a customer email.
CREATE INDEX IF NOT EXISTS idx_entity_write_log_outcome
  ON entity_write_log (outcome, created_at);

CREATE INDEX IF NOT EXISTS idx_entity_write_log_actor
  ON entity_write_log (actor_user_id, created_at);

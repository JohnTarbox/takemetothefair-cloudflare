-- G remainder (Dev backlog 2026-06-05): goodwill config table.
--
-- Single-row config so the GW1.2 flip margin -- and any future GW1.x
-- threshold (GW1.4 authority-override margin sits in the same place per
-- the 2026-06-03 spec) -- can be tuned without a deploy. Row id=1 is
-- the canonical config row; CHECK constraint enforces single-row
-- semantics so accidental INSERTs surface as a constraint violation
-- rather than silent drift.
--
-- The GW1.2 module (src/lib/goodwill/reliability-resolution.ts) shipped
-- in PR #321 with RELIABILITY_FLIP_MARGIN hardcoded to 0.2. After this
-- migration lands, getFlipMargin(db) reads from this row with the
-- hardcoded 0.2 as a memoized fallback, so a missing/empty row never
-- breaks resolution -- only delays config-driven tuning until the row
-- exists.
--
-- The accompanying operator step (separate from this PR): set
-- GOODWILL_FLIP_ENABLED='1' on the MCP Worker AND on the Pages
-- environment after a clean shadow-mode observation window.

CREATE TABLE IF NOT EXISTS goodwill_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  flip_margin REAL NOT NULL DEFAULT 0.2,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Seed the canonical row. INSERT OR IGNORE so the migration is
-- idempotent on prod (where this migration may be re-run as part of
-- a rolling redeploy) and on fresh DBs.
INSERT OR IGNORE INTO goodwill_config (id, flip_margin) VALUES (1, 0.2);

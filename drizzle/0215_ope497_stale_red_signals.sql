-- OPE-497 — make "which signals are red" answerable from the database.
--
-- The OPE-75 stale-red scan already computes a full RED set every run and mails
-- it as a digest. The only thing it persisted was a COUNT
-- (`weekly_inventory_state.stale_red_current`, currently 14). Nothing recorded
-- WHICH signals those were.
--
-- The cost, measured: on 2026-08-19 an analyst with full D1 access investigated
-- whether OPE-247's frozen-queue RED had ever fired on `promoter_enrichment`.
-- They checked `health_issues` (stale-reds never write there) and
-- `tunable_thresholds` (the values are code constants), found nothing, and
-- concluded the alert was never built. It had in fact been firing every day —
-- FROZEN through 2026-08-04..08-18 while outflow_1d was 0, and SLOW-DRAIN since
-- (6 closed against 496 arrived over 14d = 0.012, well under the 0.5 gate) —
-- and reaching John by email as "⚠️ 14 dashboard signals stuck red".
--
-- The detector was fine. It was unauditable. This table is the audit trail.
--
-- One row per signal, upserted per scan; `resolved_at` stamped by the first scan
-- that no longer sees it. So "red right now" is `resolved_at IS NULL`, and "how
-- long" needs no re-derivation.
CREATE TABLE IF NOT EXISTS stale_red_signals (
  ref_key           TEXT PRIMARY KEY,
  priority          TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  href              TEXT,
  first_detected_at INTEGER,
  hours_in_red      REAL,
  last_seen_at      INTEGER NOT NULL,
  resolved_at       INTEGER
);

-- The query the operator and the next investigator actually run.
CREATE INDEX IF NOT EXISTS idx_stale_red_signals_open
  ON stale_red_signals (resolved_at, priority);

-- OPE-497 scope 5 — the frozen/slow-drain gates were hardcoded constants, so the
-- thresholds governing a live alert were invisible to anyone inspecting the
-- database. Seeded with the existing code defaults, so behaviour is unchanged on
-- the day this lands; the code reads these and falls back to the same numbers.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES
  ('queue_frozen_zero_outflow_days', 7, 'days',
   'OPE-247/497: a queue with depth > 0 and ZERO outflow for this many days is RED (frozen). Raise to quiet a lane that legitimately batches its reviews.',
   unixepoch()),
  ('queue_slow_drain_ratio', 0.5, 'ratio',
   'OPE-247/497: 14d outflow/inflow below this is RED (slow drain). promoter_enrichment sat at 0.012 when this was seeded.',
   unixepoch())
ON CONFLICT(key) DO NOTHING;

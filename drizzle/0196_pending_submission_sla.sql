-- OPE-413 — nothing watches the one queue with members of the public waiting.
--
-- Every other work queue on the platform has a drain or staleness alert. The
-- PENDING submissions queue — the only one where a stalled row is a promise
-- broken to a named outside person — had none.
--
-- Re-measured 2026-08-17 (the ticket's figures had moved, as it warned they
-- would; the backlog was hand-drained in the filing session, which is itself the
-- manual cost this removes):
--
--   PENDING right now                 9
--   past the published 48h promise    5
--   average age                       24.5 days
--   oldest                            138 days
--   with a suggester_email            2   ← a person actually waiting
--
-- And the number that decides the threshold, measured over community/email
-- submissions approved since 2026-06-01:
--
--   approved                          6
--   reviewed within 48 hours          0     ← zero
--   fastest                           19.0 days
--
-- ---------------------------------------------------------------------------
-- Why the threshold is a row and not a constant
-- ---------------------------------------------------------------------------
--
-- The published promise is 48 hours and the observed compliance is 0%. Those
-- two numbers cannot both drive an alert: seeded at 48h it fires on essentially
-- every row, and an alert that always fires is one nobody reads — which is how
-- this queue got to 138 days in the first place.
--
-- So the threshold lives in `tunable_thresholds` where an operator can move it
-- without a deploy. It is SEEDED AT 48 anyway, deliberately, because that is the
-- promise currently printed on the public form: the alert should report reality
-- against the commitment we actually made, not against a softer number chosen to
-- keep the dashboard quiet. If the real sustainable turnaround is longer, the
-- honest fix is to change the form copy AND this row together — flagged to John
-- rather than quietly picked here.
--
-- `unit` is stored rather than implied. A bare `48` in a config table is exactly
-- the kind of value that gets read as days by someone who was not here.
CREATE TABLE IF NOT EXISTS tunable_thresholds (
  key        TEXT PRIMARY KEY,
  value      REAL NOT NULL,
  unit       TEXT NOT NULL,
  note       TEXT,
  updated_at INTEGER NOT NULL
);

INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'pending_submission_sla_hours',
  48,
  'hours',
  'OPE-413 — age at which a PENDING submission counts as breaching the review promise printed on /suggest-event. Seeded to match that published promise (48h), NOT to the observed turnaround, which was 0/6 within 48h as of 2026-08-17. Raise this only together with the form copy.',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

-- OPE-1673 — suggest_event now drops, and update_event refuses, a vendor fee
-- or application deadline that arrives without a citation. OPE-246: the guard
-- ships with its probe. `vendor-field-citations` (src/lib/heartbeat.ts) goes
-- red when an event created after enabled_at holds one of those values with no
-- active event_data_citations row for the field.
-- Armed from the ship date: no flag gates the guard.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'vendor-field-citations',
  unixepoch(),
  'OPE-1673 — no event created since arming holds an uncited vendor fee or application deadline',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

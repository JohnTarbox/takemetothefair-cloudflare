-- OPE-1683 — a sent operator draft now closes its recipient's open contact
-- obligation (email-jobs consumer). OPE-246: the path ships with its probe.
-- `operator-draft-closes-obligation` (src/lib/heartbeat.ts) goes red when a
-- draft sent after enabled_at sits next to an OPEN contact obligation from the
-- same address that opened before the send.
-- Armed from the ship date: no flag gates the close.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'operator-draft-closes-obligation',
  unixepoch(),
  'OPE-1683 — no sent operator draft leaves its recipient''s earlier contact obligation open',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

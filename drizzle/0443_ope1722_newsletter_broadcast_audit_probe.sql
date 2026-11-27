-- OPE-1722 — every newsletter broadcast (the one-tap approve route,
-- /api/admin/newsletter/send and /api/admin/newsletter/vendor-digest) now writes
-- an `admin_actions` row (action 'newsletter.broadcast'). OPE-246: the new writer
-- ships with its probe, `newsletter-broadcast-audit` (src/lib/heartbeat.ts).
-- ENABLED at ship: two lists broadcast weekly, and the 240h window is ~2x the
-- largest gap between broadcasts since 2026-08-14 (5.1 days), so the next send
-- (vendor 11-30, weekend 12-03) lands well inside it.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'newsletter-broadcast-audit',
  unixepoch(),
  'OPE-1722 — enabled at ship; evidence is an admin_actions newsletter.broadcast row',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

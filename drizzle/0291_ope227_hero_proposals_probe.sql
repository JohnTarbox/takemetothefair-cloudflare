-- OPE-227 increment C — heartbeat probe for the photo flywheel's daily hero
-- proposal run (MCP 06:00Z cron → POST /api/admin/photo-flywheel/hero-proposals).
-- ARMED at ship: every run writes one admin_actions row per candidate, and the
-- candidate pool (664 on 2026-09-16) outlasts the 30-day hold-out (≤300), so a
-- healthy daily run always leaves evidence. 48h window.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'photo-flywheel-hero-proposals',
  unixepoch(),
  'OPE-227 — daily hero proposal run; evidence = newest event.hero_proposed / event.hero_propose_attempt row',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

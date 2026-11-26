-- OPE-1558 — OPE-246 probe for the new intake surface: the no-login
-- /list-your-event form beacons `list_view` into analytics_events on mount.
-- Seeded DORMANT (enabled_at NULL): the page ships noindex and unlinked until
-- OPE-1559 adds the nav CTA (gated on John), so a live window would false-fire.
-- Arm it (set enabled_at) the day OPE-1559's CTA ships.
-- No schema change; no data rows touched — a no-op on an empty database apart
-- from this seed row.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('list-your-event-view', NULL,
  'OPE-1558: /list-your-event logs a list_view per page mount (dormant until OPE-1559 links the page)', unixepoch());

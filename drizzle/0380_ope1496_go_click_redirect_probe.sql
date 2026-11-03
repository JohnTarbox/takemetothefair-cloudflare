-- OPE-1496 — OPE-246 probe for the new writer: GET|HEAD /go/<kind>/<slug>
-- writes an analytics_events row (source='redirect') before its 302.
-- Seeded DORMANT (enabled_at NULL): no newsletter links through /go/ until the
-- analyst lane switches the digests over, so a live window would false-fire.
-- Arm it (set enabled_at) the day the first digest sends with /go/ links.
-- No schema change; no data rows touched — a no-op on an empty database apart
-- from this seed row.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('go-click-redirect', NULL,
  'OPE-1496: newsletter /go/ click redirect logs a row per hit (dormant until a digest links through it)', unixepoch());

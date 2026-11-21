-- OPE-1286 — OPE-246 probe for the new writer: the inbound workflow's
-- newsletter/candidates step, which creates PENDING events from a newsletter's
-- unmatched items once the newsletter lane owns the email.
-- Seeded DORMANT (enabled_at NULL): one newsletter had been itemized since
-- OPE-1285 shipped, so the 720h window is a placeholder, not a measurement.
-- Arm it (set enabled_at) once real step rows give an inter-arrival.
-- No schema change; no data rows touched — a no-op on an empty database apart
-- from this seed row.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('newsletter-candidates', NULL,
  'OPE-1286: newsletter/candidates step record with status ok (dormant until measured)', unixepoch());

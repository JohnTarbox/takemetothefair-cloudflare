-- OPE-1408 — seed the extract-context telemetry probe, ARMED.
--
-- The K7.4 writer (content_length_chars / content_sha256_first16) now runs on
-- every URL fetch that feeds submitExtract, including the multi-source fan-out
-- that had carried all bare-URL email since 2026-08-24 without it. Armed at
-- ship: the probe's demand is floored at enabled_at, so the pre-fix NULL rows
-- are not demand and it cannot read red on its first evaluation.
--
-- No-op on an empty database: bare INSERT, no foreign keys.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'extract-context-telemetry',
  unixepoch(),
  'OPE-1408 - evidence = inbound_emails.content_length_chars set; demand = oldest URL-extract row (parsed_url + extraction_method ai/json-ld/thin) newer than the newest evidence. Window 240h (measured inter-arrival, max gap 647h, mean 58h).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

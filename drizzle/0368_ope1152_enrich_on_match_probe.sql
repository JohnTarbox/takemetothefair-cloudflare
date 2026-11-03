-- OPE-1152 — seed the enrich-on-match disposition probe, ARMED.
--
-- The stager now writes exactly one admin_actions row per match
-- (dedup.enrich_proposed or dedup.enrich_nothing_staged). Armed at ship: the
-- probe is demand-conditional (healthy while no `already-exists` reply is newer
-- than the newest disposition row), so a quiet week cannot false-fire.
--
-- No-op on an empty database: bare INSERT, no foreign keys.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'enrich-on-match-disposition',
  unixepoch(),
  'OPE-1152 - evidence = newest admin_actions dedup.enrich_proposed / dedup.enrich_nothing_staged; demand = newest inbound_emails reply_kind=already-exists. Window 72h.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

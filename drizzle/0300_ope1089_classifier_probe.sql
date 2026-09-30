-- OPE-1089 — heartbeat probe for the inbound intent classifier.
--
-- ARMED at ship (enabled_at = now), not dormant: unlike OPE-847's roster probe,
-- this path has a measured emitting population already in the table — 209
-- successful classifications, max gap between consecutive successes 167.6h
-- all-time and 142.3h in the last 90 days. The 240h window in HEARTBEAT_PROBES
-- is measured against that, so arming it immediately cannot false-fire.
--
-- Evidence = newest inbound_emails.classified_at whose routing_source is one a
-- live classifier produces ('classifier' | 'classifier_override' |
-- 'fallback_low_confidence'). 'address_only' is what a FAILED classifier leaves,
-- which is why it is excluded — the probe watches the answer, not the attempt.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'classifier-execution',
  unixepoch(),
  'OPE-1089 — inbound intent classifier still answering; evidence = newest inbound_emails.classified_at with a fromAi routing_source. Went fully dark twice (3B non-string response 2026-05-22; 8B error 5028 2026-06-15) with no internal signal.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

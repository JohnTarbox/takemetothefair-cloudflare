-- OPE-1509 — heartbeat probe for outreach replies linked at capture
-- (`promoter-outreach/link-reply` moves the ask to `replied`).
-- Red when an inbound threads to one of our outreach sends while that ask is
-- still `sent`, i.e. the link did not happen.
-- DORMANT (enabled_at NULL): the linker ships in the MCP Worker, deployed
-- separately from the app that reads the probe. Arm once that deploy is live:
--   UPDATE heartbeat_probes SET enabled_at = unixepoch(), updated_at = unixepoch()
--   WHERE probe_name = 'outreach-reply-link';
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'outreach-reply-link',
  NULL,
  'OPE-1509 — outreach reply linked at capture; dormant until the MCP deploy carrying the linker is live',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

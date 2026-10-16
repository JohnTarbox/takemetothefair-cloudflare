-- OPE-1352 — reject-as-duplicate and merge now repoint
-- inbound_emails.resulting_event_id from the loser to the live keeper
-- (repointInboundEmailsToKeeper, packages/db-schema). OPE-246: the new write
-- path ships with its probe.
--
-- DORMANT (enabled_at NULL): 18 pre-fix inbound rows (10 rejected-as-duplicate,
-- 8 merged; measured 2026-10-15) still name a loser until the one-time backfill
-- runs with John's OK. Armed now, the probe would fire on day one for a state
-- this PR does not write. Set enabled_at the day the backfill lands.
--
-- Schema-free: no table or column changes. The original pointer is audited as
-- admin_actions(action='inbound_email.resulting_event_repoint') rows.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('inbound-follows-duplicate-keeper', NULL, 'OPE-1352: no inbound_emails.resulting_event_id names a merged_into / rejected_as_duplicate_of event; dormant until the backfill runs', unixepoch());

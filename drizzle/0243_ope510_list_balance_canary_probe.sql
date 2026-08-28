-- OPE-510 §3 — heartbeat probe for the newsletter list-balance canary.
--
-- Per OPE-246 a probe ships WITH the writer. This ticket is the case FOR that
-- rule rather than an application of it: OPE-510's canary QUERY shipped in
-- PR #996, and its only caller was the on-demand `get_data_health_report` tool.
-- Nothing ran it on a schedule and nothing alerted on it, so it was a number in
-- a report, not a canary — and a report field nobody reads is indistinguishable
-- from a cron that never runs.
--
-- The cost of that gap, from the 2026-08-28 review: four public double-opt-in
-- signups (doreen_m_gamache@homedepot.com, learninstuffct@gmail.com,
-- jfazz@mail.com, deeogt@gmail.com) confirmed between the 08-21 backfill and
-- the writer's deploy, received nothing for five to seven days, and were found
-- BY HAND when a preview_only broadcast resolved 29 recipients against 34
-- confirmed-active and somebody chased the delta. That comparison is precisely
-- what the canary was specified to automate.
--
-- Watches the RUN, not the yield, and here the yield is genuinely unprobeable:
-- the alert fires only when the invariant is BROKEN, so on every healthy day it
-- is silent. A probe on the alert would be red exactly when the system is
-- working. The canary now stamps agent_heartbeats on every run and this watches
-- the stamp.
--
-- enabled_at is set NOW rather than NULL: the run stamp ships in the same PR
-- behind no flag, so the probe has evidence to find from the first nightly run
-- after deploy.
--
-- No-op on an empty database (a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys) so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'newsletter-list-balance-canary',
  unixepoch(),
  'OPE-510 §3 — watches agent_heartbeats.last_seen_at for agent_code=watchdog:newsletter-list-balance. Probes that the daily canary RAN, never that it alerted: the alert fires only on a broken invariant, so silence is the healthy state and a yield probe would invert.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

-- OPE-348 (URGENT) — quota-independent agent-liveness heartbeats.
--
-- The 2026-08-05→09 outage: the Anthropic account's quota was exhausted and
-- EVERY scheduled agent session silently failed for ~4 days. Nothing alerted,
-- because every dead-man check we had also ran on that account — the watchdog
-- died with the watched.
--
-- Why a NEW table rather than reusing admin_actions: during the outage
-- admin_actions kept receiving rows (3, 1, 2, 2 per day). Inspecting them shows
-- every survivor was `ga4.liveness_alert` or `event.lifecycle_change` — both
-- written by CLOUDFLARE CRONS, which were entirely unaffected. A watchdog keyed
-- on admin_actions would have stayed green for all four days. The signal has to
-- be one that ONLY an agent session can produce.
--
-- `kind` exists for the same reason. The watchdog stamps its own runs here so
-- its execution is provable (OPE-246), and the agent-freshness query filters to
-- kind='agent' — otherwise the watchdog's own stamps would keep the table
-- looking fresh and reproduce the exact bug this table exists to avoid.
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id TEXT PRIMARY KEY,
  agent_code TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  last_seen_at INTEGER NOT NULL,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_heartbeats_code ON agent_heartbeats(agent_code);
CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_kind_seen ON agent_heartbeats(kind, last_seen_at);

-- OPE-246 first-evidence probe, shipped WITH the writer.
--
-- Enabled immediately (not NULL-gated): the watchdog is on a live cron from this
-- deploy, so it must stamp a run row within 48h. It writes on EVERY run, not only
-- when alerting — a watchdog whose only output is silence cannot be distinguished
-- from a dead one, which is the same failure it exists to catch.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'agent-silence-watchdog',
  unixepoch(),
  'OPE-348 — Cloudflare cron stamps agent_heartbeats(kind=watchdog) every run; no Anthropic dependency',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

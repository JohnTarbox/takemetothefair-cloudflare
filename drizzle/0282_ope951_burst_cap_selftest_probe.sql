-- OPE-951 — arm the probe for the burst-cap self-test.
--
-- CLAUDE.md (OPE-246): a new cron / execution path ships WITH its probe. This
-- PR adds the daily `burst-cap-selftest` cron (MCP Worker → main app
-- /api/internal/burst-selftest), and this row arms the probe that watches it.
--
-- Evidence is `agent_heartbeats.last_seen_at` for
-- `watchdog:burst-cap-selftest`, stamped ONLY when the production burst cap
-- admits five hits and refuses the sixth on a throwaway key. It therefore goes
-- stale if the cron stops, if the BURST_COUNTER binding is missing, OR if the
-- cap stops refusing — the last being exactly how OPE-904's Workers Rate
-- Limiting binding failed, unseen, for its whole life.
--
-- Window 48h (registry) against a once-daily 06:00Z cron. Armed now: the first
-- fire after deploy lands within 24h, inside the window.
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys — so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'burst-cap-selftest',
  unixepoch(),
  'OPE-951 - watches agent_heartbeats for agent_code=watchdog:burst-cap-selftest, stamped by POST /api/internal/burst-selftest ONLY when the production burst cap (Durable Object BurstCounter via getBurstLimiter) admits 5 hits and refuses the 6th on a throwaway key. Fired daily at 06:00Z by the MCP Worker. Stale means: cron stopped, binding missing, or the cap stopped refusing - the failure the replaced Workers Rate Limiting binding had in production. Window 48h = one missed daily fire of headroom.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

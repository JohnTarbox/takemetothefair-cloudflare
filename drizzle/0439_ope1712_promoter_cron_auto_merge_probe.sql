-- OPE-1712 — the nightly promoter-enrichment cron auto-applies again
-- (PROMOTER_ENRICHMENT_DRY_RUN = "false" in mcp-server/wrangler.toml). OPE-246:
-- the new writer path ships with its probe, `promoter-cron-auto-merge`
-- (src/lib/heartbeat.ts). ENABLED at ship: the cron fires daily at 08:00 UTC and
-- the 240h window is ~2.5x the longest gap between auto-applicable cron
-- candidates in prod (11-06 -> 11-26), so the first fire lands well inside it.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'promoter-cron-auto-merge',
  unixepoch(),
  'OPE-1712 — enabled at ship; evidence is an auto_merged promoter-cron-* candidate',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

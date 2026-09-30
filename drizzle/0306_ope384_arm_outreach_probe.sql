-- OPE-384 — arm the promoter-outreach probe the day PROMOTER_OUTREACH_ENABLED
-- flips to "true" (mcp-server/wrangler.toml, same PR), per John's GO
-- 2026-09-23. The probe was seeded dormant (enabled_at NULL) so it could not
-- false-fire while the rail was gated; left NULL now, the rail's first real
-- silence would go unnoticed.
--
-- Guarded on enabled_at IS NULL so a re-apply never moves an existing arm
-- date. No-op on an empty database (an UPDATE of zero rows, no FKs).
UPDATE heartbeat_probes
SET enabled_at = unixepoch(),
    updated_at = unixepoch()
WHERE probe_name = 'promoter-outreach-attempts'
  AND enabled_at IS NULL;

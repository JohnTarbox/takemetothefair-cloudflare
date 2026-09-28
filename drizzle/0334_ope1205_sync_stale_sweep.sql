-- OPE-1205 — the sync-staleness sweep: its tunable threshold and its heartbeat.
--
-- The default is MEASURED, not asserted. Prod, 2026-09-28, upcoming public
-- sync_enabled rows by age of COALESCE(last_synced_at, created_at):
--   <30d: 1 · 30-60d: 1 · 90-120d: 109 (rollovers / manual series adds, 1
--   confirmed) · 120-180d: 7 (5 confirmed, 4 uncited) · 180d+: 10 (9
--   confirmed, all cited).
-- 90 days = a season without a refresh. At 90 the first run downgrades 5
-- confirmed-but-uncited rows; every row older than 180 days is cited and so
-- exempt. The Harvest Festival row that prompted this had last synced 240 days
-- before its event.
--
-- No-op on an empty database: no foreign keys, ON CONFLICT DO NOTHING.

INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'sync_stale_dates_confirmed_days',
  90,
  'days',
  'OPE-1205 — a sync_enabled event whose last sync (else creation) is older than this, and whose start_date has no qualifying citation, has dates_confirmed set to 0 by the daily MCP sweep. Measured 2026-09-28: 90 downgrades 5 rows; raising it to 180 would downgrade 0 (every 180d+ row is cited).',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'sync-stale-sweep',
  unixepoch(),
  'OPE-1205 - admin_actions action=event.sync_stale_sweep must appear at least every 48h (daily cron, one row per run, even when nothing is downgraded).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

-- OPE-309 (assurance audit A6 / A7) — register three cron-output freshness
-- probes in the OPE-246 heartbeat framework.
--
-- All three are written by the 06:00Z daily cron; at ship time each had last
-- written 2026-08-03 06:00Z. `expectedWindowHours: 48` therefore tolerates
-- exactly one missed run before going red.
--
-- Why these three and not a fourth: the audit also asked for a fault-emitter
-- probe. `fault_signatures.last_seen` only advances WHEN A FAULT OCCURS, so a
-- quiet period is indistinguishable from a dead emitter — it stood at 51.7h
-- here with nothing wrong. Probing it would rebuild the false-STALE pattern
-- OPE-295 just removed. See the NOTE in src/lib/heartbeat.ts.
--
-- Enabled immediately (not dormant): all three feeds are live and producing,
-- so there is no flag to wait on and no risk of a probe firing before its path
-- exists.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES
  ('gsc-search-metrics-ingest', unixepoch(),
   'OPE-309 A6 — GSC search-metrics daily ingest; backs KPI tiles, silent failure leaves them showing a stale number.',
   unixepoch()),
  ('ga4-daily-metrics-ingest', unixepoch(),
   'OPE-309 A6 — GA4 daily-metrics ingest; same blast radius as the GSC feed.',
   unixepoch()),
  ('recommendation-scan', unixepoch(),
   'OPE-309 A7 — recommendation scan cron output (recommendation_scan_state.last_run_at).',
   unixepoch())
ON CONFLICT (probe_name) DO UPDATE SET
  enabled_at = COALESCE(heartbeat_probes.enabled_at, excluded.enabled_at),
  note = excluded.note,
  updated_at = unixepoch();

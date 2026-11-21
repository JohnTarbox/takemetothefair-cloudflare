-- OPE-1586 — heartbeat probe for the daily TENTATIVE → SCHEDULED auto-promotion
-- rule (MCP 06:00Z cron). Touches heartbeat_probes only (no FK), so it is a
-- no-op-safe insert on an empty database. Live from the ship date: the rule
-- stamps `watchdog:tentative-autopromote` on every run, whatever it promotes.
-- No schema change: promotions reuse admin_actions (event.lifecycle_change) and
-- reversals reuse event_review_flags (reason 'auto_promotion_reversed').
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'tentative-autopromote',
  1794787200,
  'OPE-1586 — watchdog:tentative-autopromote stamped within 48h (daily TENTATIVE → SCHEDULED rule)',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

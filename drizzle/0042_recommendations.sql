-- Recommendations engine — surfaces "what should I do today?" prompts on the
-- /admin/analytics Recommendations tab. Two tables:
--
-- recommendation_rules — registry of available rules. Mostly here so rules can
--   be enabled/disabled without code changes and so the UI can group items by
--   rule_id and show the rule's display title and severity.
--
-- recommendation_items — one row per (rule, target) pair currently matching the
--   rule's query. UPSERTed by the scan: new matches insert with first_seen_at,
--   re-matches just bump last_seen_at. Items that no longer match are left in
--   place (auto-resolved by the active-list query's last_seen_at filter) so
--   re-appearance reuses the same dismissed_until row.
--
-- Snooze pattern mirrors health_issue_snoozes: dismissed_until is a unix epoch
-- (seconds) past which the item re-appears, or NULL for "snooze forever". Use
-- acted_at to mark items the admin acted on (separate from dismiss).

CREATE TABLE recommendation_rules (
  id TEXT PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  rationale_template TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE recommendation_items (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES recommendation_rules(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT,
  payload_json TEXT,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dismissed_at INTEGER,
  dismissed_until INTEGER,
  dismissed_reason TEXT,
  acted_at INTEGER,
  UNIQUE (rule_id, target_id)
);

CREATE INDEX idx_recommendation_items_rule_id ON recommendation_items(rule_id);
CREATE INDEX idx_recommendation_items_dismissed_until ON recommendation_items(dismissed_until);
CREATE INDEX idx_recommendation_items_last_seen_at ON recommendation_items(last_seen_at);

-- OPE-1651 — field-level edit history for events, vendors, venues, promoters.
--
-- Append-only. One row per field whose value actually changed, written by the
-- shared `buildFieldHistoryRows` helper (packages/db-schema/src/field-history.ts)
-- from every wired write path. Old and new values are stored in FULL (no
-- truncation — truncated history defeats the purpose). No backfill is possible:
-- history starts when this ships.
--
-- Empty-db safe: a new empty table, its indexes, and the heartbeat probe seed
-- (heartbeat_probes has no FK).

CREATE TABLE entity_field_history (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT,
  changed_at INTEGER NOT NULL
);

CREATE INDEX idx_entity_field_history_entity
  ON entity_field_history (entity_type, entity_id, changed_at);
CREATE INDEX idx_entity_field_history_changed_at
  ON entity_field_history (changed_at);

-- OPE-246 — the writer ships with its probe. Admin/MCP/self-edit saves happen
-- several times a day (analyst and discovery lanes edit events daily), so a
-- 7-day silence means every wired path stopped writing history. Enabled at
-- apply time: the wiring is live the moment this deploys.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'entity-field-history',
  unixepoch(),
  'OPE-1651 — every wired event/vendor/venue/promoter edit writes entity_field_history rows',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

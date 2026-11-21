-- OPE-1618 — a claimed promoter uploads a season of shows as one CSV/XLSX file.
--
-- One row per committed spreadsheet row. UNIQUE(promoter_id, file_hash,
-- row_number) is the idempotency key: re-uploading the same file creates
-- nothing new (dedup then also matches the events it created).
--
-- outcome 'created'       — a new event, inserted PENDING (review), every value
--                           cited to the upload (event_data_citations,
--                           provenance_kind 'promoter_portal').
-- outcome 'update_staged' — the row matched the promoter's OWN event. Portal
--                           edits of a live listing are requests, not writes
--                           (OPE-1514 option D), so the differences are held in
--                           proposed_changes and the event gets a
--                           'promoter_import_update' review flag. Nothing is
--                           written to the event.
--
-- No data is written; a no-op on an empty db apart from DDL.

CREATE TABLE promoter_import_rows (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL,
  file_name TEXT,
  row_number INTEGER NOT NULL,
  outcome TEXT NOT NULL,                 -- created | update_staged
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  row_values TEXT NOT NULL,              -- JSON
  proposed_changes TEXT,                 -- JSON { field: { current, proposed } }
  uploaded_by TEXT,
  channel TEXT NOT NULL,                 -- portal | operator
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_promoter_import_rows_file_row ON promoter_import_rows (promoter_id, file_hash, row_number);
CREATE INDEX idx_promoter_import_rows_event ON promoter_import_rows (event_id);

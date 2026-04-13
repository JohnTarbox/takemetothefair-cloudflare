-- Composite index for the common events listing query pattern:
-- WHERE status IN ('APPROVED','TENTATIVE') AND (end_date >= ? OR end_date IS NULL)
-- Replaces separate idx_events_status and idx_events_end_date scans with a single index scan
CREATE INDEX IF NOT EXISTS idx_events_status_enddate ON events(status, end_date);

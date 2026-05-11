-- Add UNIQUE constraint on event_vendors(event_id, vendor_id).
--
-- Closes a latent race in update_vendor_status / create_or_link_vendor where
-- SELECT-then-INSERT could yield duplicate link rows under concurrent calls.
-- The new create_or_link_vendor tool (PR 1 of the bulk-ingest perf work)
-- relies on this constraint so the second concurrent call falls through to
-- UPDATE on conflict rather than silently inserting a duplicate.
--
-- Pre-flight de-dupe: if any duplicates exist today they would block the
-- unique-index creation. Keep only the lowest-id row for each pair (stable
-- under re-application: id ordering is a property of the data, not the
-- migration). Safe to re-run — after the first apply, the GROUP BY returns
-- exactly one row per pair so the NOT IN list covers everything else.

DELETE FROM event_vendors
WHERE id NOT IN (
  SELECT MIN(id) FROM event_vendors GROUP BY event_id, vendor_id
);

CREATE UNIQUE INDEX idx_eventvendors_event_vendor_unique
  ON event_vendors (event_id, vendor_id);

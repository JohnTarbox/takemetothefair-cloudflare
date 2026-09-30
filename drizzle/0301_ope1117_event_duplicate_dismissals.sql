-- OPE-1117 — a consumer for `events.possible_duplicate_of`.
--
-- The OPE-627 detector writes a flag roughly once every 4.6 days, and until
-- now nothing read it: of the eight flagged rows, five were resolved by people
-- who were not looking for duplicates and two expired unread past their own
-- event date, one of them publicly listed.
--
-- This table records the one verdict the schema had no way to express: "a
-- human looked, and these are two different events." It is NOT written into
-- `possible_duplicate_of` or `rejected_as_duplicate_of` — see the schema
-- comment on `eventDuplicateDismissals` for why that would poison OPE-450's
-- trusted adjudications. Keyed on the (event, candidate) PAIR.
--
-- DDL only, plus one heartbeat seed row, so it is a no-op on an empty database.
CREATE TABLE IF NOT EXISTS event_duplicate_dismissals (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  dismissed_by TEXT,
  dismissed_at INTEGER NOT NULL,
  note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_duplicate_dismissals_pair
  ON event_duplicate_dismissals (event_id, candidate_id);

-- OPE-246 — the probe ships with the path. Evidence is the daily
-- `queue_drain_snapshots` row for the new `duplicate_flags` queue: the
-- measurement RUNNING, not the depth (depth going to zero is the good outcome).
-- Armed at ship: the snapshot is written by the existing daily stale-red scan,
-- which already writes the sibling `inbound_held_submissions` row on the same
-- schedule, so the window is measured by that probe's own record.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'duplicate-flags-snapshot',
  unixepoch(),
  'OPE-1117 — the possible_duplicate_of review queue is still being measured; evidence = newest queue_drain_snapshots row for queue_name=duplicate_flags.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

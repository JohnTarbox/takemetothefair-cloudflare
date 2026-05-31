-- K2 part 5 schema foundation (analyst, 2026-05-31). events.possible_
-- duplicate_of is the marker the email pipeline's enrich-or-flag step
-- will set on incoming submissions whose dedup match was MEDIUM
-- confidence (city_state_date or similar_name_date) rather than HIGH
-- (exact_url or venue_date).
--
-- Semantics:
--   possible_duplicate_of IS NULL                  → row is its own
--                                                    independent event
--   possible_duplicate_of = <other-event-id>       → this row was created
--                                                    because dedup found
--                                                    a probable but
--                                                    not-certain match;
--                                                    the operator should
--                                                    review and decide:
--                                                    (a) confirm distinct
--                                                        → clear the
--                                                        column
--                                                    (b) confirm same →
--                                                        call merge_events
--                                                        with this as
--                                                        duplicate_id
--
-- Distinct from merged_into (drizzle/0095): merged_into is set AFTER an
-- operator has called merge_events; possible_duplicate_of is a
-- BEFORE-state pointer asking "is this a duplicate?" Different parts
-- of the lifecycle.
--
-- ON DELETE SET NULL: if the pointed-at event is deleted (or merged),
-- the pointer becomes NULL — the questionable row stays around as its
-- own independent event. Operator action required to confirm or merge.
--
-- Behavior wiring (mcp-server/src/workflows/inbound-email.ts and the
-- submit pipeline) is DEFERRED to a follow-up PR per the bundle plan
-- so the schema lands first and Part 6's sweep can reference the
-- column.
--
-- Pre-flight per [[feedback_verify_table_doesnt_exist_before_create]]:
--   PRAGMA table_info('events');  -- confirm possible_duplicate_of not present

ALTER TABLE events ADD COLUMN possible_duplicate_of TEXT REFERENCES events(id) ON DELETE SET NULL;

-- Partial index supports two query patterns:
--   1. Admin queue: "show me all PENDING events flagged as possible
--      duplicates" — visit /admin/possible-duplicates (follow-up)
--   2. Sweep canary cross-check: confirm sweep candidates are NOT
--      already flagged
CREATE INDEX IF NOT EXISTS idx_events_possible_duplicate_of
  ON events(possible_duplicate_of)
  WHERE possible_duplicate_of IS NOT NULL;

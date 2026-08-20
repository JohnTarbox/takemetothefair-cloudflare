-- OPE-502 — index event_data_citations for SOURCE-first reads.
--
-- Every existing index on this table leads with `event_id`
-- (idx_citations_event_field, idx_citations_event_state) or covers `state`
-- alone. That is exactly right for "show me this event's provenance" and
-- useless for the questions OPE-502 adds: "what else did this URL produce"
-- and "what was cited in this window".
--
-- This matters more than a read-latency argument suggests. OPE-433 is wiring
-- `dates_confirmed` to this table, which turns "which rows depend on this
-- source" into a BLAST-RADIUS query run before a correction — a scan is an
-- acceptable cost for an occasional audit and not an acceptable cost for a
-- pre-write check.
--
-- Pure additive DDL: creates no rows, references no rows, and is therefore a
-- clean no-op against the empty D1 that CI builds from migrations.

CREATE INDEX IF NOT EXISTS idx_citations_source_url
  ON event_data_citations (source_url);

-- Ordered (created_at, id) to match the tool's stable sort — created_at desc,
-- id desc — so a paged window sweep can walk the index instead of re-sorting.
CREATE INDEX IF NOT EXISTS idx_citations_created_at
  ON event_data_citations (created_at, id);

-- OPE-692 — a citation must be answerable without re-fetching its source.
--
-- `event_data_citations.source_url` is written so a later pass can confirm the
-- source still says what we recorded. It cannot: an unattended pass's
-- `web_fetch` accepts a URL only from a user message, a prior fetch result or a
-- search result, and a URL read out of our own database is none of those. So a
-- citation has been write-only — it records that a source existed on the day it
-- was written and nothing downstream can ask it a second question.
--
-- Specimen: the Harmony Free Fair citation (written 2026-08-30, confidence=1)
-- points at harmonyfreefair.com, which returns ZERO search results while an
-- abandoned 2024 weebly mirror ranks first. A sweep came one step from filing
-- "the 2024 program has been day-shifted onto 2026 dates" as a live defect. The
-- un-checkable citation is what stopped it, and it stopped it by being READ,
-- not by being verified.
--
-- These columns make the citation carry its own evidence. They turn "the URL is
-- unreachable" from a statement about the EVENT into a statement about the URL.
--
-- Pure ADD COLUMN: no backfill, no FK, no-op on an empty database. CI applies
-- every migration to a fresh D1, and an insert of snapshot ids would abort the
-- whole run (see docs/bulk-mutation-discipline.md and the 0-row rule).
-- Existing rows read NULL, which is honest: they were written before anything
-- captured this and pretending otherwise would fabricate provenance.

ALTER TABLE event_data_citations ADD COLUMN source_title TEXT;
ALTER TABLE event_data_citations ADD COLUMN source_excerpt TEXT;
ALTER TABLE event_data_citations ADD COLUMN source_content_hash TEXT;
ALTER TABLE event_data_citations ADD COLUMN source_fetched_at INTEGER;

-- 'unchecked' | 'confirmed' | 'changed' | 'unreachable'
-- Deliberately TEXT with no CHECK, matching entity_claims.entity_type: widening
-- the vocabulary should not be a migration, and the enum is enforced in
-- TypeScript where the readers live.
ALTER TABLE event_data_citations ADD COLUMN recheck_state TEXT;
ALTER TABLE event_data_citations ADD COLUMN recheck_at INTEGER;
ALTER TABLE event_data_citations ADD COLUMN recheck_note TEXT;

-- "Which citations has nobody been able to re-check?" is the question this
-- ticket exists to make answerable, so it gets an index rather than a scan.
CREATE INDEX IF NOT EXISTS idx_citations_recheck_state
  ON event_data_citations (recheck_state, recheck_at);

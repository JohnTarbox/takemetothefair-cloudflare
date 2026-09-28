-- OPE-1180 — FORMER venues, phase 1: lifecycle columns + three history tables.
--
-- Pure DDL: no row is read or written, so this is a no-op on an empty
-- database (CI builds its D1 from migrations) and changes no existing
-- behaviour. `venues.status` has no CHECK constraint, so the new FORMER value
-- needs no table rebuild; `address` / `zip` stay NOT NULL — a FORMER venue
-- with no known address stores '' (validation allows that for FORMER only).

ALTER TABLE venues ADD COLUMN use_started_edtf TEXT;
ALTER TABLE venues ADD COLUMN use_ended_edtf TEXT;
ALTER TABLE venues ADD COLUMN use_ended_earliest INTEGER;
ALTER TABLE venues ADD COLUMN use_ended_latest INTEGER;
ALTER TABLE venues ADD COLUMN current_state TEXT;
ALTER TABLE venues ADD COLUMN current_use TEXT;
ALTER TABLE venues ADD COLUMN wikidata_qid TEXT;
ALTER TABLE venues ADD COLUMN nrhp_ref TEXT;

-- "Series S was held at venue V from A to B." series_id OR series_name: a
-- historical series with no MMATF events is recorded by name, so no empty
-- /events/<series> hub is ever created for it.
CREATE TABLE series_venue_periods (
  id TEXT PRIMARY KEY NOT NULL,
  series_id TEXT REFERENCES event_series(id) ON DELETE SET NULL,
  series_name TEXT,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  from_edtf TEXT,
  to_edtf TEXT,
  from_earliest INTEGER,
  to_latest INTEGER,
  certainty TEXT NOT NULL DEFAULT 'certain',
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  CHECK (series_id IS NOT NULL OR (series_name IS NOT NULL AND length(trim(series_name)) > 0))
);
CREATE INDEX idx_series_venue_periods_venue ON series_venue_periods (venue_id);
CREATE INDEX idx_series_venue_periods_series ON series_venue_periods (series_id);

CREATE TABLE venue_name_variants (
  id TEXT PRIMARY KEY NOT NULL,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  from_edtf TEXT,
  to_edtf TEXT,
  certainty TEXT NOT NULL DEFAULT 'certain',
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_venue_name_variants_unique ON venue_name_variants (venue_id, normalized_name);
CREATE INDEX idx_venue_name_variants_normalized ON venue_name_variants (normalized_name);

-- One source per claim; exactly one target.
CREATE TABLE venue_claim_citations (
  id TEXT PRIMARY KEY NOT NULL,
  venue_id TEXT REFERENCES venues(id) ON DELETE CASCADE,
  series_venue_period_id TEXT REFERENCES series_venue_periods(id) ON DELETE CASCADE,
  venue_name_variant_id TEXT REFERENCES venue_name_variants(id) ON DELETE CASCADE,
  field TEXT,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  certainty TEXT NOT NULL DEFAULT 'certain',
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (venue_id IS NOT NULL) + (series_venue_period_id IS NOT NULL) + (venue_name_variant_id IS NOT NULL) = 1
  )
);
CREATE INDEX idx_venue_claim_citations_venue ON venue_claim_citations (venue_id);
CREATE INDEX idx_venue_claim_citations_period ON venue_claim_citations (series_venue_period_id);
CREATE INDEX idx_venue_claim_citations_variant ON venue_claim_citations (venue_name_variant_id);

-- ── The date guard, as a structural backstop ─────────────────────────────
-- Application code checks FORMER venues on the named write paths and answers
-- with a message (refuse) or by leaving the venue empty and flagging (ingest,
-- rollover). These triggers make the REFUSE outcome true on every write path,
-- including one nobody remembered: an event cannot be attached to a FORMER
-- venue with a last day after the venue's closure. REJECTED rows are exempt
-- (not public; tombstones keep their venue). An undated event is not refused
-- here — it is flagged by the code paths, which is the ticket's rule.
CREATE TRIGGER trg_events_former_venue_insert
BEFORE INSERT ON events
WHEN NEW.venue_id IS NOT NULL
  AND NEW.status <> 'REJECTED'
  AND COALESCE(NEW.end_date, NEW.start_date) IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM venues v
    WHERE v.id = NEW.venue_id
      AND v.status = 'FORMER'
      AND (v.use_ended_latest IS NULL OR COALESCE(NEW.end_date, NEW.start_date) > v.use_ended_latest)
  )
BEGIN
  SELECT RAISE(ABORT, 'FORMER_VENUE_AFTER_CLOSURE: this venue closed before the event date (OPE-1180)');
END;

CREATE TRIGGER trg_events_former_venue_update
BEFORE UPDATE OF venue_id, start_date, end_date, status ON events
WHEN NEW.venue_id IS NOT NULL
  AND NEW.status <> 'REJECTED'
  AND COALESCE(NEW.end_date, NEW.start_date) IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM venues v
    WHERE v.id = NEW.venue_id
      AND v.status = 'FORMER'
      AND (v.use_ended_latest IS NULL OR COALESCE(NEW.end_date, NEW.start_date) > v.use_ended_latest)
  )
BEGIN
  SELECT RAISE(ABORT, 'FORMER_VENUE_AFTER_CLOSURE: this venue closed before the event date (OPE-1180)');
END;

-- And the other direction: a venue cannot BECOME FORMER (or move its closure
-- earlier) while a non-REJECTED event after the closure still references it.
CREATE TRIGGER trg_venues_former_with_later_events
BEFORE UPDATE OF status, use_ended_earliest ON venues
WHEN NEW.status = 'FORMER'
  AND EXISTS (
    SELECT 1 FROM events e
    WHERE e.venue_id = NEW.id
      AND e.status <> 'REJECTED'
      AND COALESCE(e.end_date, e.start_date) > COALESCE(NEW.use_ended_earliest, 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'FORMER_VENUE_HAS_LATER_EVENTS: events after the closure still reference this venue (OPE-1180)');
END;

-- A series' DEFAULT venue (where future occurrences inherit it from) is never
-- a FORMER venue: the series outlived those grounds. NULLed rather than
-- refused, so an ingest that creates or updates a series never fails on it.
CREATE TRIGGER trg_event_series_former_venue_insert
AFTER INSERT ON event_series
WHEN NEW.venue_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM venues v WHERE v.id = NEW.venue_id AND v.status = 'FORMER')
BEGIN
  UPDATE event_series SET venue_id = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER trg_event_series_former_venue_update
AFTER UPDATE OF venue_id ON event_series
WHEN NEW.venue_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM venues v WHERE v.id = NEW.venue_id AND v.status = 'FORMER')
BEGIN
  UPDATE event_series SET venue_id = NULL WHERE id = NEW.id;
END;

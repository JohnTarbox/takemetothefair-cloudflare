-- Event Data Citations — provenance log for event field values that come from
-- external sources (homepage hero, press release, vendor PDF, etc.).
--
-- One row per citation, not per field. The `field_name` column is free-text so
-- new tracked fields don't require migrations. Multiple citations per
-- (event, field, year) are allowed; lifecycle (state) resolves which row is the
-- current authority — typically a new `active` insert supersedes the prior
-- `active` for the same (event, field, year) tuple.
--
-- Citations are never deleted in the normal flow; corrections set state to
-- `rejected` or `stale`. Hard delete is reserved for the rare audit-cleanup
-- case and goes through the delete_event_citation MCP tool, which writes to
-- admin_actions for audit.
--
-- The denormalized columns on the events table (estimated_attendance,
-- vendor_fee_min_cents, vendor_fee_max_cents, ticket_price_min_cents,
-- ticket_price_max_cents, application_deadline) remain as the public-facing
-- cache of the current `active` citation for each field. They are kept in
-- sync by the create_event_citation tool and by the update_event tool's
-- optional `citation` param.
--
-- See packages/db-schema/src/index.ts:eventDataCitations for the typed schema.
-- See MMATF-Analysis/MMATF-Automation-Spec.md §4.3.1 for the design spec.
-- Migration added 2026-05-11.

CREATE TABLE event_data_citations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  value TEXT NOT NULL,
  year INTEGER,
  source_url TEXT NOT NULL,
  source_name TEXT,
  source_type TEXT NOT NULL,    -- official_website | news_article | press_release | social_media | user_submitted | other
  confidence REAL,
  state TEXT NOT NULL DEFAULT 'active', -- active | superseded | rejected | stale
  notes TEXT,
  supersedes_citation_id TEXT REFERENCES event_data_citations(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_citations_event_field ON event_data_citations (event_id, field_name);
CREATE INDEX idx_citations_event_state ON event_data_citations (event_id, state);
CREATE INDEX idx_citations_state ON event_data_citations (state);

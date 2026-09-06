-- OPE-463 — a fault record for inbound extraction, plus the email→events join
-- the fan-out signature is not computable without.
--
-- ## Why a SIBLING table and not a widening of `fault_signatures`
--
-- The ticket asks which and why. Sibling, for three reasons:
--
--  1. `fault_signatures.route` means a browser page route and `error_class`
--     means a JS error class. An extraction fault has neither — it has a
--     submission and a field. Redefining those columns would make the same two
--     names mean different things depending on which producer wrote the row.
--  2. `/admin/analytics` counts `fault_signatures` as "render fault health"
--     (OPE-808). Mixing extraction faults in would silently change a displayed
--     number to describe two populations, which is the defect class OPE-808
--     just finished removing.
--  3. OPE-811 established one status vocabulary across the CPI rail. A sibling
--     table SHARES that vocabulary while keeping the populations separable —
--     the reuse that matters is the vocabulary, not the table.
--
-- Canonical CPI columns are present so the skill's Procedure A queries run
-- unchanged: eligibility `status IN ('open','proposed') AND ope_id IS NULL`,
-- regression `resolved_at IS NOT NULL AND last_seen > resolved_at`.
CREATE TABLE IF NOT EXISTS extraction_faults (
  signature TEXT PRIMARY KEY,
  -- What produced it: 'email_submission', 'url_import', 'photo_intake', ...
  source TEXT NOT NULL,
  -- The fault family, typed as a cpi.config family_id so CPI stage 2 (Tier-0
  -- classify) resolves without a second mapping layer.
  family_id TEXT NOT NULL,
  -- Free-form detail for a human: the field, the counts, the offending value.
  detail TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'proposed',
  ope_id TEXT,
  filed_at INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extraction_faults_status ON extraction_faults(status);
CREATE INDEX IF NOT EXISTS idx_extraction_faults_family ON extraction_faults(family_id);

-- OPE-463 scope 4 — one inbound email, many events.
--
-- `inbound_emails.resulting_event_id` is singular, so a submission that created
-- six events recorded one. Per-submission precision was therefore not
-- computable at all: the fan-out figures in the filing analysis had to be
-- reconstructed by time-bucketing `events.created_at`, which is a heuristic,
-- not a join.
--
-- ⚠️ Scoped deliberately AGAINST OPE-459 item 5, which logs which *sources*
-- were attempted. This logs which *events* resulted. Different grain; both are
-- needed; neither implies the other.
--
-- `resulting_event_id` is left in place and untouched — it is read in several
-- places and this is additive.
CREATE TABLE IF NOT EXISTS inbound_email_events (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_email_events_pair
  ON inbound_email_events(inbound_email_id, event_id);
CREATE INDEX IF NOT EXISTS idx_inbound_email_events_event
  ON inbound_email_events(event_id);

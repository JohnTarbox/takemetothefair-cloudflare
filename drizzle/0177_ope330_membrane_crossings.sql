-- OPE-330 (Demux D-4) — the membrane-crossing ledger.
--
-- Seven defects this summer were all the same shape: a SILENT BOUNDARY. Work
-- crossed from one queue to another — email to ticket, email to hold, hold to
-- resolve, review to rework — and nothing recorded the crossing, so when the
-- work stopped moving nobody could tell WHERE it stopped. OPE-285's feedback
-- sat 24h unseen; the Maynard poster reached a lane that couldn't finish it;
-- OPE-254's photos stranded at a hold.
--
-- One row per crossing makes "what happened to this email?" a single query
-- keyed on source_ref, and — more usefully — makes a MISSING crossing
-- detectable, because a crossing is always paired with a source row that does
-- exist. The probe joins inbound_emails against this table rather than hunting
-- for an absence (the distinction that made OPE-319 a CI guard instead).
--
-- Deliberately SEPARATE from email_send_ledger (OPE-319/OPE-151), which the
-- ticket offered as an option. Different nouns: that table records outbound
-- MESSAGES we sent to people; this records WORK moving between queues. Merging
-- them would force one schema to answer two unrelated questions, and the
-- "did we email this person" query would start returning internal transitions.

CREATE TABLE IF NOT EXISTS membrane_crossings (
  id TEXT PRIMARY KEY,
  -- Where the work came FROM. Free-form by design: `inbound_email:<id>`,
  -- `issue:OPE-330`, `hold:<id>`. Typed refs would need a table per source.
  source_ref TEXT NOT NULL,
  -- Where it went. NULL when the crossing is a terminal hold — the absence is
  -- the signal the probe looks for.
  destination_ref TEXT,
  -- email_to_ticket | email_to_hold | hold_to_resolve | review_to_rework |
  -- route_to_lane. Text, not CHECK: adding a crossing type should not need a
  -- migration, and every reader filters on the values it knows.
  crossing_type TEXT NOT NULL,
  -- system | agent | human. Who caused it — the question asked first when a
  -- crossing looks wrong.
  actor TEXT NOT NULL DEFAULT 'system',
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- "What happened to this email?" is the query this table exists to answer, so
-- source_ref is the index that matters.
CREATE INDEX IF NOT EXISTS idx_membrane_crossings_source ON membrane_crossings (source_ref);
-- The probe scans recent rows by type; keep that off a full table scan.
CREATE INDEX IF NOT EXISTS idx_membrane_crossings_type_created
  ON membrane_crossings (crossing_type, created_at);

-- OPE-246 heartbeat probe seed. Enabled immediately: the writers ship in the
-- same PR, so there is no flag to wait on and no dormant window.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('membrane-crossing-ledger', unixepoch(),
        'OPE-330 D-4 — liveness of the crossing ledger itself. If it stops writing, every boundary goes back to invisible and nothing would otherwise say so.',
        unixepoch())
ON CONFLICT (probe_name) DO UPDATE SET
  enabled_at = COALESCE(heartbeat_probes.enabled_at, excluded.enabled_at),
  note = excluded.note,
  updated_at = unixepoch();

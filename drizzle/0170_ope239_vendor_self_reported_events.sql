-- OPE-239 — vendor self-attested event participation.
--
-- "Which of our fairs have you sold at?" Demand-side roster capture: every
-- existing path (web backfill OPE-13/14/23, inbound-email rosters OPE-176,
-- booth photos OPE-204) is supply-side and therefore blind to organizers who
-- publish no exhibitor list. The vendor always knows where they exhibited.
--
-- WHY A SEPARATE TABLE, NOT AN `event_vendors.status` VALUE (which is what the
-- ticket literally asked for):
--
--   `event_vendors` has 52 consumers in this repo and the overwhelming majority
--   do NOT filter on `status` — public event pages, schema.org performer/sponsor
--   arrays, CSV exports, roster-coverage metrics. Adding a SELF_REPORTED value
--   to that enum would make all of them silently present an UNVERIFIED vendor
--   self-claim as a confirmed roster entry.
--
--   That is precisely what the ticket forbids ("must not pollute
--   get_roster_coverage or organizer-confirmed rosters" / "don't let
--   self-attestation inflate roster coverage"). A separate table achieves
--   "never conflated" BY CONSTRUCTION instead of by auditing 40 call sites.
--
-- Public labeling was approved by John on 2026-07-28: a separate profile
-- section headed "Fairs this vendor says they've attended" with a muted
-- "Vendor-stated — not confirmed by the organizer" note, never merged into the
-- confirmed list.
--
-- Positive-only: a row here boosts the OPE-237 trust signal; absence never
-- penalizes (keep-all).
CREATE TABLE IF NOT EXISTS vendor_self_reported_events (
  id              TEXT PRIMARY KEY,
  vendor_id       TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- 'claim' (at signup) | 'profile' (self-service editor) | 'admin'
  source_context  TEXT NOT NULL DEFAULT 'profile',
  -- SELF_REPORTED is the only value a vendor can set. CORROBORATED / DISPUTED
  -- are admin-only triage and NEVER promote the row into event_vendors —
  -- confirmed participation stays the organizer's word.
  status          TEXT NOT NULL DEFAULT 'SELF_REPORTED',
  evidence_note   TEXT,
  evidence_url    TEXT,
  created_at      INTEGER NOT NULL,
  reviewed_at     INTEGER,
  reviewed_by     TEXT
);

-- One assertion per (vendor, event): re-selecting the same fair is a no-op
-- rather than a duplicate, which makes the write idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vsre_vendor_event
  ON vendor_self_reported_events (vendor_id, event_id);
CREATE INDEX IF NOT EXISTS idx_vsre_vendor ON vendor_self_reported_events (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vsre_event  ON vendor_self_reported_events (event_id);

-- OPE-246 probe, seeded DORMANT (enabled_at NULL) — deliberately.
--
-- Every other probe watches a scheduled or automatic writer, where silence is a
-- defect. This writer is DEMAND-DRIVEN: it only fires when a human vendor
-- chooses to fill in the picker. There is no honest liveness window for that
-- until adoption exists — a 30-day window would simply page us about vendor
-- behaviour we don't control, and a probe that cries wolf trains people to
-- ignore the digest.
--
-- Per the OPE-246 rule, a dormant probe never false-fires. Set enabled_at once
-- there is a baseline adoption rate to hold the feature to.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'vendor-self-reported-events',
  NULL,
  'OPE-239 vendor self-attested participation — DORMANT: demand-driven writer, no honest liveness window until adoption exists. Set enabled_at once a baseline rate is known.',
  unixepoch()
)
ON CONFLICT (probe_name) DO NOTHING;

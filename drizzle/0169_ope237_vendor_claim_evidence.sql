-- OPE-237 — vendor claim/registration realness evidence.
--
-- Automates what an analyst did by hand on 2026-07-16 for `cd-ceramics-and-
-- florals`: screen a new self-registered vendor for realness vs. spam and hand
-- /admin/claims ranked evidence instead of a blank page.
--
-- TRIGGER IS REGISTRATION, NOT A CLAIM — verified, not assumed. The ticket
-- assumed claims arrive via claim/direct + claim/confirm. Prod D1, 2026-07-27:
--   entity_claims rows                      = 1
--   admin_actions matching '%claim%'        = 0   (those endpoints never fired)
--   vendors.claimed = 1                     = 14
--   ...of which created in the SAME SECOND as the claiming user = 13
-- Those 13 came from the register route's `else if (businessName)` branch,
-- which mints a listing for a registrant who supplies a business name. That is
-- the live path, and the ticket instructs confirming it before hooking the
-- trigger.
--
-- Guardrails (ticket §Notes): nothing here auto-applies to a public vendor row,
-- and no score auto-approves or auto-rejects a claim. It ranks work for a human.
CREATE TABLE IF NOT EXISTS vendor_claim_evidence (
  id                    TEXT PRIMARY KEY,
  vendor_id             TEXT NOT NULL,
  user_id               TEXT,
  claimant_name         TEXT,
  claimant_email        TEXT,
  business_name         TEXT NOT NULL,
  declared_website      TEXT,
  -- JSON CoherenceSignals from src/lib/claims/realness.ts
  signals               TEXT NOT NULL DEFAULT '{}',
  -- STRONG | WEAK | NONE | UNAVAILABLE. Defaults to UNAVAILABLE so an
  -- un-run pass reads as "not checked", never as "clean".
  corroboration         TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  corroboration_detail  TEXT,
  score                 INTEGER NOT NULL DEFAULT 0,
  band                  TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
  reasons               TEXT NOT NULL DEFAULT '[]',
  created_at            INTEGER NOT NULL,
  assessed_at           INTEGER,
  reviewed_at           INTEGER,
  reviewed_by           TEXT
);

-- One evidence row per vendor; registration mints the listing exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vce_vendor   ON vendor_claim_evidence (vendor_id);
CREATE INDEX        IF NOT EXISTS idx_vce_band     ON vendor_claim_evidence (band);
CREATE INDEX        IF NOT EXISTS idx_vce_created  ON vendor_claim_evidence (created_at);

-- OPE-246 first-evidence probe. This PR ships a new writer, so it declares the
-- D1 evidence that writer must keep producing.
--
-- Window is 30 days: the observed rate is ~13 vendor self-registrations in the
-- 16 days to 2026-07-27, but signups are lumpy and seasonal (fair season peaks
-- then stops), so a tighter window would false-fire over a quiet fortnight.
-- enabled_at is the ship date — the writer is live on merge, not flag-gated.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'vendor-claim-evidence',
  strftime('%s', '2026-07-27'),
  'OPE-237 — every vendor self-registration must write a vendor_claim_evidence row',
  unixepoch()
)
ON CONFLICT (probe_name) DO NOTHING;

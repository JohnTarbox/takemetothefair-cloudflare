-- I1 vendor-enrichment Worker (Dev-Brief-I1, 2026-06-13) — dry-run staging
-- table. The nightly cron + enrich_vendor MCP tool render a vendor's own
-- website via Browser Rendering, extract fill-empty-only contact fields, and
-- write PROPOSALS here. Nothing touches the live `vendors` row until an
-- operator (Phase 1) or the auto-merge gate (Phase 2) approves.
--
-- §6.2 domain-problem flagging reuses the EXISTING vendors.domain_hijacked
-- column (drizzle/0054) — no new column. §6.1 is this table.
--
-- IF NOT EXISTS (2026-06-15): the I1 worker (PR #478) created this table in prod
-- out-of-band, so `wrangler d1 migrations apply --remote` kept failing on
-- "table already exists" (SQLITE_ERROR 7500) and blocked every deploy since 0123.
-- Guarding all CREATEs makes the re-apply a no-op that records the migration as
-- applied; harmless on fresh DBs.
CREATE TABLE IF NOT EXISTS vendor_enrichment_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id         TEXT NOT NULL,
  -- Groups one cron run's proposals so a whole night can be approved/rejected
  -- as a batch. Synchronous enrich_vendor calls use a 'manual-<uuid>' run id.
  job_run_id        TEXT NOT NULL,
  -- contact_phone | contact_email | social_links | address | city | state | description
  proposed_field    TEXT NOT NULL,
  -- The vendor's value at proposal time. Always NULL under fill-empty-only,
  -- but stored for audit (and to detect a race where it got filled meanwhile).
  current_value     TEXT,
  proposed_value    TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  -- 'jsonld' | 'mailto' | 'tel' | 'social-link' | 'regex'
  extraction_method TEXT NOT NULL,
  -- 'standard' | 'browser-rendering' — which fetch path produced the HTML.
  fetch_method      TEXT,
  confidence        REAL NOT NULL DEFAULT 0,
  -- JSON array of safety-rule flags, e.g. ['city_mismatch','area_code_mismatch'].
  -- A non-empty flags array NEVER auto-merges, even after the Phase-2 gate flips.
  flags             TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  reviewed_at       INTEGER,
  reviewed_by       TEXT,
  -- pending | approved | rejected | auto_merged
  decision          TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_vec_vendor ON vendor_enrichment_candidates (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vec_decision ON vendor_enrichment_candidates (decision);
CREATE INDEX IF NOT EXISTS idx_vec_job_run ON vendor_enrichment_candidates (job_run_id);

-- Idempotence: re-enriching a vendor before its prior proposals are reviewed
-- must not pile up duplicate pending rows for the same field. Partial unique
-- index — only one OPEN proposal per (vendor, field); reviewed rows are exempt
-- so history accumulates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vec_pending_field
  ON vendor_enrichment_candidates (vendor_id, proposed_field)
  WHERE decision = 'pending';

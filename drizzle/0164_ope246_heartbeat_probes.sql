-- OPE-246 — post-ship first-evidence heartbeat: the operator-settable
-- enablement anchor per probe. Probe definitions (evidence query, window,
-- owner) live in code (src/lib/heartbeat.ts); this table holds only the ONE
-- datum that changes without a deploy — `enabled_at`.
--
-- A row with enabled_at IS NULL is DORMANT: its silence is expected (the path
-- isn't enabled yet), so it never fires a RED. The silence clock runs from
-- max(enabled_at, last-evidence), so a live path stays green while producing and
-- reds only if it STOPS.
CREATE TABLE heartbeat_probes (
  probe_name TEXT PRIMARY KEY,
  enabled_at INTEGER,        -- seconds-epoch; NULL = dormant
  note TEXT,
  updated_at INTEGER NOT NULL
);

-- Seed the live probes at a safe past anchor (their true silence signal is
-- last-evidence, which dominates while they're producing). booth-autowrite is
-- DORMANT — gated by PHOTO_AUTOWRITE_ENABLED=false; set enabled_at the day that
-- flag flips on.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at) VALUES
  ('photo-intake',          strftime('%s','2026-07-01'), 'OPE-202 photos@ lane', unixepoch()),
  ('ocr-attachment',        strftime('%s','2026-07-01'), 'OPE-68 attachment OCR', unixepoch()),
  ('email-send',            strftime('%s','2026-07-01'), 'OPE-151 send ledger', unixepoch()),
  ('inbound-submit',        strftime('%s','2026-07-01'), 'OPE-174 event submissions', unixepoch()),
  ('vendor-enrichment',     strftime('%s','2026-07-01'), 'I1 vendor enrichment cron', unixepoch()),
  ('promoter-enrichment',   strftime('%s','2026-07-01'), 'OPE-36 promoter enrichment cron', unixepoch()),
  ('discrepancy-detection', strftime('%s','2026-07-01'), 'GW1 discrepancy detection', unixepoch()),
  ('gw1d-scorer',           strftime('%s','2026-07-01'), 'OPE-245 outreach scorer', unixepoch()),
  ('booth-autowrite',       NULL,                        'OPE-240 — dormant until PHOTO_AUTOWRITE_ENABLED flips on', unixepoch());

-- OPE-1705 — business-card photos are read for their fields and applied to a
-- matched vendor (identity blanks filled, contact fields staged as private
-- enrichment candidates) or staged as `vendor.card_proposed`. OPE-246: the new
-- execution path ships with its probe, `business-card-lane` (src/lib/heartbeat.ts).
-- DORMANT: enabled_at NULL. Cards arrive only when John photographs one; set
-- enabled_at the day the first live card writes a vendor.card_* row.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'business-card-lane',
  NULL,
  'OPE-1705 — dormant until the first live business card; arm enabled_at that day',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

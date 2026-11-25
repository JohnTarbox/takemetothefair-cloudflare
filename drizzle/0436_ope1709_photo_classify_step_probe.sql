-- OPE-1709 — every Snap photo's vision pass now records a workflow step
-- (`photo/cards-only` / `photo/classify`) naming what each photo was read as.
-- OPE-246: the new writer ships with its probe, `photo-classify-step`
-- (src/lib/heartbeat.ts). A served-ness probe: it fires only when a Snap upload
-- newer than enabled_at has no step row after it, so it cannot page on a quiet
-- season. ARMED from 2026-11-26T00:00:00Z (enabled_at 1795651200): uploads before the
-- deploy predate the writer, and the first one after it is the first evidence.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'photo-classify-step',
  1795651200,
  'OPE-1709 — armed at ship; a Snap upload with no photo/* step after it is a miss',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

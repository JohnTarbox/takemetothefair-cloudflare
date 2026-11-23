-- OPE-1705 slice 2 — a business card is paired with the booth shot just before
-- it (same uploader, same event, within CARD_PAIR_WINDOW_MINUTES, default 10),
-- recorded as `vendor.card_paired`. OPE-246: the new writer ships with its probe,
-- `card-booth-pairing` (src/lib/heartbeat.ts).
-- DORMANT: enabled_at NULL. A pairing needs a real booth + card shot at a fair;
-- set enabled_at the day the first live pairing row lands.
-- Touches heartbeat_probes only; a no-op on an empty database beyond the seed.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'card-booth-pairing',
  NULL,
  'OPE-1705 slice 2 — dormant until the first live booth+card pairing; arm enabled_at that day',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

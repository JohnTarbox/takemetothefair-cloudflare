-- OPE-1341 — "Snap booth" capture page: photos uploaded straight from the phone
-- become `inbound_emails` rows (intent='photo_intake', routing_source='snap-app')
-- so they run through the SAME photo-intake workflow, handler, booth pipeline,
-- provenance (`admin_actions.target_id`) and intake accounting as emailed ones.
--
-- `capture_meta` carries what an email would have carried in EXIF and the
-- subject, decided ONCE at ingest:
--   { client_id, captured_at, location: {latitude, longitude, accuracy_m} | null,
--     location_source: 'exif' | 'device' | 'none', taken_on_local_date,
--     event_id, event_slug, note, actor }
-- The stored image is EXIF-stripped before it reaches R2, so this column — not
-- the bytes — is where the handler reads location from for a snap.
--
-- Additive; NULL for every existing row (= unchanged behaviour). Safe on an
-- empty database.
ALTER TABLE inbound_emails ADD COLUMN capture_meta TEXT;

-- OPE-246 probe, ARMED at ship: its evidence is demand-conditional (healthy
-- while no snap is waiting), so quiet weeks between fairs cannot false-fire it.
-- It fires only when a snap row sits in received/processing past its window.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('snap-intake', unixepoch(),
  'OPE-1341: no snap-app photo_intake row left unprocessed (demand-conditional)', unixepoch());

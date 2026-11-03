-- OPE-1316 Ask 1 — the import-url extractor now writes an `info` row on every
-- successful AI extraction ("AI extraction ok"). OPE-246: a new writer ships
-- with its heartbeat probe. DORMANT (enabled_at NULL): there is no success data
-- yet to size a window against, and a guessed window would false-fire or never
-- fire. The arming ticket measures the inter-arrival and sets enabled_at.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('import-url-extract-success', NULL, 'OPE-1316: newest "AI extraction ok" info row from api/admin/import-url/extract; dormant until measured', unixepoch());

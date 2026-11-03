-- OPE-1285 — heartbeat for the newsletter itemize step (OPE-246: a new
-- execution path ships with its probe). ARMED: the step runs on every
-- classified newsletter, which have arrived every 7.6 days on average
-- (largest gap 17.9 days, 2026-07-10 → 10-02); the window is 720h.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('newsletter-itemize', unixepoch(), 'OPE-1285: newsletter/itemize step record with status ok', unixepoch());

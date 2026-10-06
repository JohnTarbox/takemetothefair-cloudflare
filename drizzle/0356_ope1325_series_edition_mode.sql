-- OPE-1325 — multi-edition series, step 2/5 (Option A, approved by John
-- 2026-10-05; spec: OPE-1315 round-2 report §3 and §5). Additive only.
--
-- Nothing reads these columns yet. Step 3 (OPE-1326) teaches the read paths to
-- honour them, step 4 (OPE-1327) the write paths, and step 5 (OPE-1328) flips
-- NEAR-Fest alone. Until then every series is 'annual' and every edition_key is
-- NULL, so no URL, canonical, sitemap entry or ETag can change.
--
-- No-op on an empty DB: two ADD COLUMNs, one index and one INSERT OR IGNORE
-- with no FK and no dependence on existing rows.

-- Per-series flag. 'annual' keeps today's /events/<series>/<YYYY> URLs
-- byte-for-byte; 'multi' (set only by step 4's set_series_edition_mode tool)
-- addresses each occurrence by its edition_key. The CHECK keeps a typo from
-- becoming a third mode the code would silently read as annual.
ALTER TABLE event_series ADD COLUMN edition_mode TEXT NOT NULL DEFAULT 'annual'
  CHECK (edition_mode IN ('annual', 'multi'));

-- The edition's URL key on a multi-edition series: YYYY-MM of the start date in
-- the venue's time zone, plus an operator-chosen suffix on a same-month clash
-- (e.g. 2027-05-xli). STORED and frozen at creation, so editing an edition's
-- dates, or the UTC-vs-Eastern year split, can never move its URL. NULL on every
-- annual-series occurrence.
ALTER TABLE events ADD COLUMN edition_key TEXT;

-- One edition per key per series. SQLite already treats NULLs as distinct in a
-- UNIQUE index, so the NULL key on every annual row is never a conflict either
-- way; the WHERE keeps those ~all-NULL rows out of the index entirely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_series_edition_key
  ON events (series_id, edition_key)
  WHERE edition_key IS NOT NULL;

-- OPE-246 — the heartbeat for the path that will write edition keys. DORMANT
-- (enabled_at NULL): no row can carry a key until step 4 ships and step 5 flips
-- a series, so an armed probe would only false-fire. Step 5 sets enabled_at.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('series-edition-key', NULL, 'OPE-1325: newest events row with a non-NULL edition_key; dormant until OPE-1328 flips a series', unixepoch());

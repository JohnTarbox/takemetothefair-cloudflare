-- OPE-1597 — the /admin/duplicates similarity sweep compared only the first 500
-- rows of each table (500 of 13,936 vendors), recomputed on every page load.
-- A daily job now compares the whole table and stores the result here.
--
-- `entity_duplicate_sweep_runs` holds one row per entity type: the current run.
-- `entity_duplicate_sweep_pairs` holds the pairs, keyed by run. The run row is
-- written only after its pairs are read back, so a run that dies midway leaves
-- the previous result on screen.
--
-- Proposals only: nothing here merges a record.
CREATE TABLE entity_duplicate_sweep_runs (
  entity_type TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  last_run_at INTEGER NOT NULL,
  checked_count INTEGER NOT NULL,
  live_count INTEGER NOT NULL,
  comparisons INTEGER NOT NULL,
  pair_count INTEGER NOT NULL,
  stored_pair_count INTEGER NOT NULL
);

CREATE TABLE entity_duplicate_sweep_pairs (
  run_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity1_id TEXT NOT NULL,
  entity2_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  PRIMARY KEY (run_id, entity1_id, entity2_id)
);

CREATE INDEX idx_entity_duplicate_sweep_pairs_read
  ON entity_duplicate_sweep_pairs (run_id, similarity DESC);

-- OPE-246: first-evidence probe for the new writer. Armed at ship: the silence
-- clock starts here, and the 48h window spans two daily cron cycles.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'entity-duplicate-full-sweep',
  unixepoch(),
  'OPE-1597 — daily full-table similarity sweep writes one entity_duplicate_sweep_runs row per type',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

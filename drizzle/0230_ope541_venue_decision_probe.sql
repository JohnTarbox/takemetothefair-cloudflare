-- OPE-541 — seed the `venue-decision-writer` heartbeat probe.
--
-- Why a probe at all. This ticket ships a NEW WRITER: ingest now mints venue
-- rows from email prose when `autoLinkVenue` returns `no-match` (authorized
-- 2026-08-24, answering OPE-531's open question). The OPE-246 rule is that a
-- new execution path ships its evidence in the same PR, not as a follow-up.
--
-- What it watches, and why NOT the obvious thing. The tempting probe is
-- "newest venue minted by ingest". That is a YIELD, not a run: minting fires
-- only when a submission carries an unknown venue AND a city AND a state, so a
-- quiet week — or a week in which every venue happened to match an existing
-- row — produces zero minted venues with nothing broken. That probe would RED
-- on ordinary weather, get muted, and then read as coverage while covering
-- nothing, which is strictly worse than having no probe.
--
-- So it watches the RUN instead: `max(error_logs.timestamp)` where
-- `source = 'api/suggest-event/submit:venue-resolution'`. That row is written
-- once per submission for EVERY outcome — matched, pre-resolved, ambiguous,
-- no-match, minted, and each refusal reason. Its absence means the venue
-- decision path itself stopped executing, which is the only claim a probe here
-- can honestly make. It covers the minting writer because minting lives inside
-- that same block: no decision rows means no minting either.
--
-- 72h rather than 48, for the reason the OPE-540 citation probe uses: this
-- tracks submission volume, which is bursty and contains legitimate multi-day
-- gaps (2026-08-12 → 08-16, 08-08 → 08-10 both had none).
--
-- Enabled immediately rather than dormant. There is no feature flag to wait
-- on, and the emitting code shipped in 1954b3cf — the row exists from the
-- first submission after deploy. If NOTHING is submitted for 72h the probe
-- REDs, and that is the correct reading: the pipeline this ticket is about has
-- gone silent.
--
-- Pure insert into a probe-registry table with no FK to any other data, so it
-- is a clean no-op against the empty D1 that CI builds from migrations.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'venue-decision-writer',
  unixepoch(),
  'OPE-541 — watches max(error_logs.timestamp) for source=api/suggest-event/submit:venue-resolution. Probes the RUN (a decision row per submission, every outcome) rather than the YIELD (venues minted), because minting requires an unknown venue plus city plus state and would RED on a quiet week.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

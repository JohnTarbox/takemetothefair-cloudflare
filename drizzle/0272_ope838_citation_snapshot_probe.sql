-- OPE-838 — arm the citation source-snapshot probe.
--
-- The inbound pipeline now stores what the fetched page SAID (source_title /
-- source_excerpt / source_content_hash / source_fetched_at) at the moment it
-- reads it. Before this, those columns were only ever written by hand through
-- `update_event`'s citation arg, so a correct automated extraction landed
-- looking unverifiable — `source_verifiable` is DERIVED from exactly those
-- fields (admin-citations.ts:881), not stored.
--
-- CLAUDE.md requires a new writer to ship with its probe in the same PR.
--
-- ⚠️ Evidence is `source_content_hash IS NOT NULL`, chosen as the
-- discriminator after measuring prod on 2026-09-07: across all 1,539 citation
-- rows, source_content_hash is non-null on 0 and source_title /
-- source_fetched_at are non-null on 44 (the hand-written agent rows). Keying on
-- title or fetched_at would let a HUMAN edit satisfy a probe whose whole job is
-- to watch a MACHINE. Only the automated writer hashes the page.
--
-- Window 504h, MEASURED against this probe's OWN population — inbound emails
-- that fetched a URL and created an event — not borrowed from the busier
-- all-writers citation probe next to it. Over 180 days: 43 active days, 42
-- gaps, mean 2.67 days, MAXIMUM 16.0 days (2026-06-05 -> 2026-06-21). 336h
-- would have fired once on ordinary quiet; 384h would sit exactly ON the
-- observed maximum, which is the error OPE-830 had to correct twice.
--
-- ⚠️ ARMED, not dormant. OPE-588's probe was seeded NULL because its evidence
-- was behind a flag; this writer ships unflagged here. With no evidence yet,
-- OPE-243's anchor falls back to enabled_at, making this a true FIRST-evidence
-- probe: no hashed citation within 21 days of shipping IS the finding.
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys — so the fresh D1 that CI builds from migrations applies it
-- without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'citation-source-snapshot',
  unixepoch(),
  'OPE-838 - watches max(event_data_citations.created_at) WHERE source_content_hash IS NOT NULL, the signature unique to the automated inbound writer (0 of 1,539 prod rows carried one at ship time; the 44 rows with a title/fetched_at were hand-written by an agent, so keying on those would let a human satisfy a machine probe). The all-writers citation probe cannot catch this regression: a row with a null excerpt is still a row. Window 504h, measured on this population: 42 gaps over 180d, mean 2.67d, MAX 16.0d - 336h false-fires once, 384h sits exactly on the maximum.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

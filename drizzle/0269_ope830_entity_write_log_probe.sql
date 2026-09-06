-- OPE-830 — heartbeat probe seed for the vendor write history (OPE-246 rail).
--
-- `entity_write_log` is a NEW writer, and CLAUDE.md requires a probe to ship
-- with the writer rather than after it: the most-recurring defect class in this
-- repo is "shipped but silently not executing".
--
-- The stakes here are higher than usual. This table exists to answer "did a
-- save happen, and what did it do". If it silently stops recording, the
-- absence of rows reads as "no saves happened" — the instrument fails in
-- exactly the direction that produced OPE-830 in the first place.
--
-- `enabled_at` is set now, not NULL: the writer ships live in this same PR
-- behind no flag, so the probe should start watching immediately. (A probe
-- gated behind a flag would take NULL and be enabled the day the flag flips.)
--
-- No-op on an empty database — a bare INSERT with ON CONFLICT DO NOTHING and
-- no foreign keys — so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'entity-write-log-writer',
  unixepoch(),
  'OPE-830 - watches entity_write_log for rows of ANY outcome (applied/noop/rejected), written by the vendor profile PATCH at src/app/api/vendor/profile/route.ts. Deliberately not scoped to applied: that would go red on a quiet week rather than a broken writer, and would miss the regression most worth catching - the rejection path being dropped in an auth-gate refactor, which compiles clean and breaks no test.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

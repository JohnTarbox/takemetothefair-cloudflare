-- OPE-325 — seed the poster-evidence heartbeat probe, ARMED.
--
-- CLAUDE.md (OPE-246): a new writer path ships WITH its probe. The poster lane
-- now archives each resolved poster to the CDN, cites every extracted field to
-- that archived copy, and offers it as a hero proposal
-- (mcp-server/src/photo/poster-evidence.ts). All three are fail-soft, so the
-- only symptom of the path dying is evidence silently not appearing.
--
-- DEMAND-CONDITIONAL (see `demandConditionalEvidence` in src/lib/heartbeat.ts):
-- silence is measured from the newest poster that resolved to an event, never
-- from the newest success, because posters are bursty (4 staged 08-24 → 08-27,
-- then none for 27 days). With no outstanding demand it reads healthy, so it can
-- ship ARMED without false-firing through a quiet month.
--
-- No-op on an empty database: no foreign keys, ON CONFLICT DO NOTHING.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'poster-evidence',
  unixepoch(),
  'OPE-325 - a poster that resolved to an event (poster-staged info log) must be followed by poster-evidence at info level: archived to cdn events/<id>/posters/, cited, hero-proposed. Demand-conditional: healthy when no resolved poster is outstanding; otherwise silence counts from that poster. Window 24h; evidence is written seconds after demand in the same handler call.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

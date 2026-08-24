-- OPE-540 — seed the `event-data-citations-writer` heartbeat probe.
--
-- Why this probe exists. Every email-submitted event created on 2026-08-24
-- had ZERO citations (`25c9c493`, `1da06d90`, `ea4fcb63`, `f5bc157e`,
-- `5f917800`). Nothing noticed. It surfaced only because an unrelated
-- acceptance criterion on OPE-537 happened to check `list_event_citations`.
--
-- The failure is silent by construction: the submission pipeline reports
-- success, the event row is created and reads as complete at approval time,
-- and only the provenance row is missing. Nothing in the product degrades
-- visibly, so nothing complains. That is precisely the "shipped but silently
-- not executing" class the OPE-246 probe rule exists for.
--
-- What it watches. `max(event_data_citations.created_at)` — the newest
-- citation of ANY kind. Deliberately NOT scoped to a source_type or to the
-- inbound path: several writers feed this table (the inbound pipeline,
-- `update_event`'s citation argument, goodwill field flips), and a probe
-- narrow enough to name one of them would go RED on a quiet week instead of
-- on a broken writer. The looser signal is the honest one here — it answers
-- "is anything still recording provenance", which is the question that went
-- unanswered for a full day.
--
-- 72h, not the usual 48. Citation volume tracks submission volume, which is
-- bursty: the 30-day history contains legitimate multi-day gaps with no
-- submissions at all (2026-08-12 through 08-16, 08-08 through 08-10). A
-- window that fires on ordinary quiet is a window that gets muted, and a
-- muted probe is worse than no probe because it reads as coverage.
--
-- Enabled immediately rather than dormant: the table already holds 1,175 rows
-- with a newest timestamp inside the window, so the probe has evidence from
-- its first sweep and cannot false-RED on ship.
--
-- Pure insert into a probe-registry table with no FK to any other data, so
-- this is a clean no-op against the empty D1 that CI builds from migrations.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'event-data-citations-writer',
  unixepoch(),
  'OPE-540 — watches max(event_data_citations.created_at). Every email-submitted event on 2026-08-24 got zero citations and nothing noticed; the pipeline reports success and only provenance is missing. Intentionally unscoped across writers: a per-source probe would RED on a quiet week rather than on a dead writer.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

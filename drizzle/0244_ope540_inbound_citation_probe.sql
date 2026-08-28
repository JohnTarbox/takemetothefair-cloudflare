-- OPE-540 — heartbeat probe for the inbound pipeline's citation writer.
--
-- Per OPE-246 a probe ships WITH the writer. This is the ticket that shows the
-- cost of skipping it: the per-source citation writer produced 108 rows in four
-- months and its output was, on the ordinary path, always zero. Nothing said so.
-- It surfaced only because an unrelated OPE-537 acceptance test happened to
-- check citation counts.
--
-- Watches the STEP RECORD, not the citation rows. A citation-row probe would be
-- a yield probe, and this yield legitimately reaches zero: the writer fires only
-- when an email submission creates or dedups an event, and inbound runs at about
-- four new-event emails a week. The `citations` step row is written on every
-- attempt whatever the outcome — including `skipped` WITH the branch that
-- returned zero — so its absence means the path stopped executing, which is the
-- only failure worth paging about.
--
-- 336h (14 days), matching `venue-decision-writer`, for the same reason: at this
-- volume a quiet fortnight is ordinary and a shorter window cries wolf. The cost
-- is honest — a dead writer takes up to two weeks to surface — and it is the
-- most this traffic supports without the probe being muted.
--
-- enabled_at is set NOW rather than NULL: the step record shipped in PR #1021
-- and the fix that makes the ordinary path reach it ships in this PR, behind no
-- flag, so the probe has evidence to find from the next inbound submission.
--
-- No-op on an empty database (a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys) so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'inbound-citation-writer',
  unixepoch(),
  'OPE-540 — watches workflow_run_steps.recorded_at for step_name=citations. Probes that the inbound citation path RAN, never how many rows it wrote: the yield is legitimately zero on a quiet week at ~4 new-event emails/week.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

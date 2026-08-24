-- OPE-532 — seed the `inbound-held-submissions-snapshot` heartbeat probe.
--
-- Enabled immediately rather than dormant: the queue row ships in the same PR
-- and the daily snapshot cron already runs, so the probe has evidence from its
-- first sweep and cannot false-RED.
--
-- Why this probe exists at all. The ticket it belongs to is about three
-- detectors that watched ten submissions be lost on 2026-08-23 and said
-- nothing — OPE-17's triage notice (wrong status + wrong intent), the
-- `inbound_exceptions` queue (all 9 live held rows are flagged_for_review=0)
-- and OPE-247's frozen-queue RED (the queue was not registered at all). Adding
-- a fourth counter without asking "what tells us THIS one stopped?" would
-- repeat the same mistake one level up.
--
-- What it watches, and why THIS signal. Evidence is a snapshot ROW existing for
-- the queue — the measurement running — deliberately NOT the depth. A depth of
-- zero is the GOOD outcome and is indistinguishable from nobody looking; only
-- the row's presence separates "nothing is held" from "the counter died".
-- Queue depth staying flat is the freeze-alert's job, not this probe's.
--
-- 48h window against a daily snapshot: one missed run is a blip, two is a
-- pattern. Same reasoning as its sibling probes on daily crons.
--
-- Pure insert into a probe-registry table with no FK to any other data, so it
-- is a clean no-op against the empty D1 that CI builds from migrations.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'inbound-held-submissions-snapshot',
  unixepoch(),
  'OPE-532 — watches max(queue_drain_snapshots.created_at) for queue_name=inbound_held_submissions. Probes that the MEASUREMENT ran, never the depth: depth 0 is the good outcome and cannot be told from a dead counter.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

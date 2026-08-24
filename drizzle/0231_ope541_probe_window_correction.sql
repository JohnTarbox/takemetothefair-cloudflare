-- OPE-541 correction — the `venue-decision-writer` window was measured after
-- it shipped, and 72h was wrong.
--
-- 0230 set 72h by analogy with the OPE-540 citation probe. Analogy was the
-- mistake: that probe watches a table several writers feed, while this one
-- watches a path with NO cron, which executes only when somebody submits.
-- Its floor is therefore however long the submission queue can legitimately
-- go quiet, and that is measurable rather than arguable.
--
-- Over the 90 days to 2026-08-24, across 313 gaps between consecutive
-- submit-route events:
--
--     max gap    241.5h   (ended 2026-07-10)
--     > 72h        7 gaps  — 126.7h / 115.4h / 94.7h all within the last month
--     > 48h        8 gaps
--     mean          6.8h
--
-- So the shipped window would have RED'd roughly once a fortnight on ordinary
-- quiet. 0230's own note says a probe that fires on ordinary weather gets
-- muted and then reads as coverage while covering nothing; this is that,
-- committed by the migration that warned about it.
--
-- The code window moves to 336h (clears the observed maximum with headroom,
-- and is the window `event-series-write-path` already uses for this reason).
-- This migration only realigns the operator-visible note, so the probe list
-- does not describe a threshold the code no longer uses.
--
-- Idempotent UPDATE against a row 0230 created; a no-op on the empty D1 that
-- CI builds from migrations, since the WHERE matches nothing there.
UPDATE heartbeat_probes
   SET note = 'OPE-541 — watches max(error_logs.timestamp) for source=api/suggest-event/submit:venue-resolution. Probes the RUN (a decision row per submission, every outcome) rather than the YIELD (venues minted). Window 336h, measured: over 90 days, 7 of 313 submission gaps exceeded 72h and the largest was 241.5h, so the original 72h would have fired on ordinary quiet.',
       updated_at = unixepoch()
 WHERE probe_name = 'venue-decision-writer';

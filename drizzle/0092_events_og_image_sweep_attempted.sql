-- events.og_image_sweep_attempted_at — "tried, don't re-select" marker
-- for the og:image sweep. Without this, every sweep call re-selects the
-- same first-N imageless events; if those all skip on Phase 2a gates
-- (no og:image, dead URL, dimension reject, logo down-rank, etc.) the
-- sweep can never advance past the head of the backlog.
--
-- Same shape as the source-domain backfill loop fix (drizzle/0090 +
-- PR #250). Set on every iteration (success OR skip) so a skipped row
-- drops out of the SELECT predicate. A future "retry attempted" admin
-- action can NULL the column on selected events when Phase 2b's
-- web-search fallback gives us a different fetch strategy worth
-- re-trying.

ALTER TABLE events ADD COLUMN og_image_sweep_attempted_at INTEGER;

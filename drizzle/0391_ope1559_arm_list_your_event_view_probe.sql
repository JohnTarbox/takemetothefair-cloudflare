-- OPE-1559 — arm the `list-your-event-view` probe (OPE-1558, seeded dormant in
-- 0388). Its arming condition was "the day OPE-1559's nav/contextual CTA ships":
-- this migration ships in the same PR as that CTA (primary nav, mobile menu,
-- footer, event pages, state + facet pages), and the deploy runs migrations
-- immediately before the Worker, so enabled_at lands minutes ahead of the CTA,
-- well inside the probe's 7-day window.
-- Only sets enabled_at while it is still NULL; a no-op on an empty database
-- (0388 seeds the row there too, so it arms it, harmlessly).
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1558: /list-your-event logs a list_view per page mount (armed OPE-1559 with the nav CTA)'
WHERE probe_name = 'list-your-event-view' AND enabled_at IS NULL;

-- OPE-1508 — arm the text-match-record probe (OPE-1505, seeded dormant in 0384).
-- Measured on prod 2026-10-27, over the week since the writer deployed
-- (2026-10-20 16:02Z): ZERO demand rows (free_text, URL-less, attachment-less,
-- submit-pipeline) and zero `submit/text-match` step rows. Demand is rare: 3
-- such rows ever, none since the deploy. The probe is demand-conditional, so
-- with no demand it reads green and cannot false-fire; arming it means the
-- FIRST real no-URL submission is checked, which a week of waiting could not
-- do. The writer's guard (`!parsedUrl || isFreeText`, inbound-email.ts) is a
-- superset of the demand filter, so every demand row reaches the writer.
-- Only sets enabled_at while it is still NULL; a no-op on an empty database.
-- `enrich-auto-apply` (0385) stays dormant: zero qualifying matches this week.
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1505: submit/text-match step row per no-URL submission (armed OPE-1508; demand-conditional, 0 demand in the first week)'
WHERE probe_name = 'text-match-record' AND enabled_at IS NULL;

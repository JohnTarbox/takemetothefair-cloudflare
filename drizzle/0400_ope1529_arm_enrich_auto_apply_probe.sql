-- OPE-1529 — arm the enrich-auto-apply probe (OPE-1506, seeded dormant in 0385).
-- Measured on prod 2026-11-10, from the writer's deploy (2026-10-20 16:02Z):
-- 7 `dedup.enrich_proposed` rows from 4 emails, all `autoApply.basis` NULL, all
-- stopped at the unambiguous-match gate, so ZERO qualifying matches and zero
-- `dedup.enrich_applied` rows. Trusted senders are active (31 of 178 inbound,
-- 18 with a DMARC pass), so demand can arrive. The probe is demand-conditional:
-- with no demand it reads green and cannot false-fire. Arming means the
-- writer's FIRST real match is checked, which three weeks of waiting could not do.
-- Only sets enabled_at while it is still NULL; a no-op on an empty database.
UPDATE heartbeat_probes
SET enabled_at = unixepoch(), updated_at = unixepoch(),
    note = 'OPE-1506: enrich-on-match auto-apply writes dedup.enrich_applied (armed OPE-1529; demand-conditional, 0 qualifying matches in the first 3 weeks)'
WHERE probe_name = 'enrich-auto-apply' AND enabled_at IS NULL;

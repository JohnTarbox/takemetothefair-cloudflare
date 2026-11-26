-- OPE-1709 rework — arm the OPE-1705 `business-card-lane` probe.
-- drizzle/0434 seeded it DORMANT (enabled_at NULL) with the instruction "set
-- enabled_at the day the first live card writes a vendor.card_* row". That day
-- is 2026-11-26: John's live acceptance wrote two `vendor.card_applied` rows
-- (snap-dc426dc2 at 03:39:05Z, snap-3e8b3c03 at 03:41:30Z; read from prod
-- admin_actions). enabled_at = the first of them, 1795664345.
-- Only arms a still-dormant row (enabled_at IS NULL), so a re-run or a later
-- manual arm is never overwritten. A no-op on an empty database (no row).
-- `card-booth-pairing` stays dormant: no live pairing has happened yet.
UPDATE heartbeat_probes
SET enabled_at = 1795664345,
    note = 'OPE-1705 — armed 2026-11-26 from the first live vendor.card_applied row (OPE-1709)',
    updated_at = unixepoch()
WHERE probe_name = 'business-card-lane' AND enabled_at IS NULL;

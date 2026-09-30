-- OPE-813 (GATE-NOISE G4) — close the discrepancies that were never conflicts.
--
-- `ingest_addverify`'s `city_state_date` gate matched on city + state + date
-- within ±7 days and treated that as evidence the two rows described the same
-- event. It is not: two unrelated events in one town in one week satisfy it
-- completely. Measured 2026-09-06, 7 of the 14 open rows paired demonstrably
-- distinct events — Norwalk Oyster Festival vs St. George Greek Festival,
-- Rhode Island Bridal Expo vs Providence Winter Farmers Market — and 3 were
-- eligible to drive a promoter email about a contradiction between two
-- unrelated events.
--
-- ⚠️ `superseded_by_identity_gate`, NOT `dismissed` and NOT
-- `resolved_authoritative`.
--
--   `dismissed` means a human looked and judged the data. Nobody did, and that
--     status feeds a live metric — the G1/G2/G3 cleanup avoided it for exactly
--     this reason.
--   `resolved_authoritative` means an authority settled the value. None did.
--
-- The honest statement is that the row should never have been opened, and it
-- sits in the bookkeeping bucket alongside `superseded_by_lifecycle` (OPE-306)
-- and `superseded_by_normalization` (OPE-307).
--
-- ⚠️ Also clears `outreach_candidate`. A row that is not a conflict must not
-- remain eligible to drive an email, and closing it without clearing the flag
-- would leave the ranker holding a resolved row it still scores.
--
-- Idempotent and a no-op on an EMPTY db: the WHERE clause matches nothing when
-- the table is empty or already swept, so CI's fresh-D1 migration run applies
-- it cleanly.
UPDATE event_discrepancies
SET resolution_status  = 'superseded_by_identity_gate',
    resolved_at        = strftime('%s','now'),
    -- `resolution_source`, not `resolution_reason`: this table has no such
    -- column. I wrote `resolution_reason` first (it exists on `health_issues`)
    -- and my local check passed because the fixture table I hand-wrote HAD
    -- that column. Verified against the live schema instead.
    resolution_source  = 'OPE-813: city_state_date matched on place+time coincidence, not identity — never a conflict',
    outreach_candidate = 0
WHERE detected_by = 'ingest_addverify'
  AND resolved_at IS NULL
  AND notes LIKE 'city_state_date:%';

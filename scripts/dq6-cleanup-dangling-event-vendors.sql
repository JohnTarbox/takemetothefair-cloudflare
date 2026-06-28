-- OPE-13 / DQ6 — one-time cleanup of DANGLING event_vendors links.
--
-- A "dangling" link is an event_vendors row whose vendor has been soft-deleted
-- (vendors.deleted_at IS NOT NULL). Going forward these are already hidden:
-- list_event_vendors + get_event_details now filter on isNull(vendors.deleted_at)
-- (this same PR). This script removes the EXISTING rows so the data matches the
-- read path — primarily the ~77 reported on NH Outdoor Expo.
--
-- SAFETY — this DELETEs rows. Do NOT add it to drizzle/ (the auto-applied
-- migration chain); it is intentionally a standalone script so an operator runs
-- it DELIBERATELY after reviewing the preview, per the OPE-6 "deleting data
-- needs issue-level approval" boundary and the repo's "never run DELETE without
-- explicit confirmation" rule.
--
-- HOW TO RUN (operator, after approval):
--   1. Run STEP 1 (preview) and eyeball the rows/count.
--   2. If correct, run STEP 2 (delete).
--   3. Run STEP 3 (verify zero remain).
-- Use the Cloudflare Developer Platform MCP `d1_database_query` tool against
-- takemetothefair-db (prod D1 SELECT via wrangler is blocked by the classifier).
-- The DELETE is idempotent: re-running it after a clean run removes 0 rows.

-- ── STEP 1 — PREVIEW (read-only) ──────────────────────────────────
-- Inspect exactly what STEP 2 will remove, scoped to NH Outdoor Expo.
SELECT ev.id AS event_vendor_id,
       e.name AS event_name,
       v.business_name,
       v.deleted_at
FROM event_vendors ev
JOIN events  e ON e.id = ev.event_id
JOIN vendors v ON v.id = ev.vendor_id
WHERE v.deleted_at IS NOT NULL
  AND (e.name LIKE '%NH Outdoor Expo%' OR e.name LIKE '%New Hampshire Outdoor Expo%')
ORDER BY v.business_name;

-- Count only:
-- SELECT COUNT(*) AS dangling_links
-- FROM event_vendors ev
-- JOIN events  e ON e.id = ev.event_id
-- JOIN vendors v ON v.id = ev.vendor_id
-- WHERE v.deleted_at IS NOT NULL
--   AND (e.name LIKE '%NH Outdoor Expo%' OR e.name LIKE '%New Hampshire Outdoor Expo%');

-- ── STEP 2 — DELETE (mutating; run only after reviewing STEP 1) ────
DELETE FROM event_vendors
WHERE id IN (
  SELECT ev.id
  FROM event_vendors ev
  JOIN events  e ON e.id = ev.event_id
  JOIN vendors v ON v.id = ev.vendor_id
  WHERE v.deleted_at IS NOT NULL
    AND (e.name LIKE '%NH Outdoor Expo%' OR e.name LIKE '%New Hampshire Outdoor Expo%')
);

-- ── STEP 3 — VERIFY (read-only; expect 0) ─────────────────────────
SELECT COUNT(*) AS remaining_dangling_links
FROM event_vendors ev
JOIN events  e ON e.id = ev.event_id
JOIN vendors v ON v.id = ev.vendor_id
WHERE v.deleted_at IS NOT NULL
  AND (e.name LIKE '%NH Outdoor Expo%' OR e.name LIKE '%New Hampshire Outdoor Expo%');

-- ── OPTIONAL — generalize to ALL events ───────────────────────────
-- The NH Outdoor Expo filter scopes this to the reported case. To sweep every
-- event's dangling links, drop the `AND (e.name LIKE …)` clause from STEP 1/2/3.
-- Preview first; the read path already hides these, so this is pure hygiene.

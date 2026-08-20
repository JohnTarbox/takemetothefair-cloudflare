-- OPE-498 — reclassify the five PARTIAL rosters that were never resumable.
--
-- Measured 2026-08-20: ALL FIVE PARTIAL rows had vendor_roster_offset equal to
-- their vendor_count. That is not five coincidences — the offset was never a
-- stopping point, it was the entire payload a server-side fetch receives:
--
--   Auburn Home Show 2026            40/40   mainehomeshow.com (empty body today)
--   Brewster Summer Craft Festival   60/60   castleberryonlinemarketplace (Azure SPA)
--   Guilford Craft Expo 2026         25/25   artrider.com (Wix lazy gallery)
--   NH State Home Show               60/61   expofp.com (interactive floorplan)
--   Worcester Spring Home Expo       60/60   map-dynamics.com (interactive floorplan)
--
-- Guilford is the proof: the Artrider page serves exactly 25 artists in its HTML
-- while the page's own copy states the show has 175 makers. The other 150 are
-- behind client-side pagination.
--
-- Why it cost more than five rows: a PARTIAL carrying a source_url AND an offset
-- is the cheapest-looking item in the drain — no search needed, just resume — so
-- every pass reached for these, re-fetched the identical first page, and wrote
-- the same offset back. None had moved since 2026-07-20/27.
--
-- ⚠️ OFFSETS ARE DELIBERATELY PRESERVED. They are the only record of where each
-- run reached, and the filer explicitly declined to overwrite them. Only the
-- status changes.
--
-- ⚠️ NOT NO_PUBLIC_LIST. These lists ARE public — we simply cannot reach them
-- with the fetch we have. Filing them under the permanent dead-end would erase a
-- real, sized inventory opportunity (Guilford alone: 150 uncaptured makers).
--
-- Pinned to the five known ids rather than a `WHERE offset = vendor_count` rule:
-- a future row could legitimately stop exactly at its count, and a rule would
-- silently reclassify it. Idempotent (the status predicate makes a re-run a
-- no-op) and a no-op on CI's empty database.
UPDATE events
   SET vendor_roster_status = 'NEEDS_RENDERED_FETCH'
 WHERE vendor_roster_status = 'PARTIAL'
   AND id IN (
     '8a95ca10-0cbf-475b-81af-568db1fb0efc',  -- Auburn Home Show 2026
     'b3cf98698c249ed4b731e1e1a2f224c9',      -- Brewster Summer Craft Festival 2026
     'ed837bf5-0c0d-4800-b09d-2579600bdd01',  -- Guilford Craft Expo 2026
     'e983a99b-2073-4684-b44d-7b85cc0d0cac',  -- NH State Home Show
     '66bdb0b8-b032-48ab-9fe8-3f71cb42f652'   -- Worcester Spring Home Expo 2026
   );

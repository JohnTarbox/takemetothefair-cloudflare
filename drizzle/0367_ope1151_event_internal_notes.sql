-- OPE-1151 — events get a PRIVATE internal-notes home, and the analyst prose
-- parked in the public `access_notes` column moves into it.
--
-- WHY A SEPARATE TABLE, NOT `events.internal_notes`: the events row is
-- serialized whole on public surfaces. `eventJoinProjection` carries every
-- events column into 15 public listing/detail modules, and the event page's
-- loader does a full-row `select()` whose result reaches "use client"
-- components (so the RSC payload). A private COLUMN on events would need a
-- strip at every one of those sites — the OPE-1084 bug class, waiting. A
-- separate table cannot be reached by any `select().from(events)`, so it is
-- private by construction. It also keeps the events/venue/promoter join under
-- D1's 100-column cap (see event-join-projection.ts).
--
-- DATA MOVE (docs/bulk-mutation-discipline.md): 9 rows, read by eye from prod
-- on 2026-10-15 (65 non-empty access_notes rows total; review list in the PR).
-- 6 are pure analyst prose -> access_notes becomes NULL; 3 are mixed -> the
-- visitor sentence(s) stay. In EVERY case the full original text is copied
-- verbatim into event_internal_notes first, so nothing is deleted.
--   single-writer : one migration.
--   idempotent    : every statement is guarded on `id = ? AND access_notes =
--                   <exact original text>`; after the first apply the guard no
--                   longer matches, so a re-run (or an empty DB) changes nothing.
--                   The INSERT runs BEFORE the UPDATE so the copy is made while
--                   the guard still matches.
--   read-back     : SELECT event_id FROM event_internal_notes WHERE notes LIKE
--                   '[OPE-1151%' -> 9 rows; and the 9 ids' access_notes equal the
--                   "after" values listed in the PR.
--   rollback      : see the commented block at the bottom.

CREATE TABLE event_internal_notes (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  notes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- asbury-annual-blueberry-festival (prose)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] 2026-08-03 sweep: TWO issues. (1) Venue: event is at Asbury United Methodist Church, 90 Church Ave, Forestville — Bristol CONNECTICUT, not Bristol RI; verify/fix our venue record. (2) 2026 appears scaled down to a "Blueberry Breakfast and Bake Sale" (FestivalNet listing has garbled dates); 2025 pattern was 2nd Saturday. Needs organizer confirmation (860-584-0529).', unixepoch(), unixepoch()
FROM events
WHERE id = '80478d42-ea97-42d8-9bdc-8fd2c4a202ad' AND access_notes = '2026-08-03 sweep: TWO issues. (1) Venue: event is at Asbury United Methodist Church, 90 Church Ave, Forestville — Bristol CONNECTICUT, not Bristol RI; verify/fix our venue record. (2) 2026 appears scaled down to a "Blueberry Breakfast and Bake Sale" (FestivalNet listing has garbled dates); 2025 pattern was 2nd Saturday. Needs organizer confirmation (860-584-0529).'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = NULL
WHERE id = '80478d42-ea97-42d8-9bdc-8fd2c4a202ad' AND access_notes = '2026-08-03 sweep: TWO issues. (1) Venue: event is at Asbury United Methodist Church, 90 Church Ave, Forestville — Bristol CONNECTICUT, not Bristol RI; verify/fix our venue record. (2) 2026 appears scaled down to a "Blueberry Breakfast and Bake Sale" (FestivalNet listing has garbled dates); 2025 pattern was 2nd Saturday. Needs organizer confirmation (860-584-0529).';

-- bar-harbor-summer-fine-arts-festival-2026 (mixed)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] Organizer is artist Marc Fink (marcfink.com/shows), venue is the Bar Harbor Inn grounds on the waterfront — not the Village Green. Fri noon–7pm, Sat 9am–7pm, Sun 10am–5pm. A separate "Fine Arts Festival II" runs Sept 11–13 — do not merge.', unixepoch(), unixepoch()
FROM events
WHERE id = 'f8b9d6ca-bb0d-4ccd-9961-3dab12843a96' AND access_notes = 'Organizer is artist Marc Fink (marcfink.com/shows), venue is the Bar Harbor Inn grounds on the waterfront — not the Village Green. Fri noon–7pm, Sat 9am–7pm, Sun 10am–5pm. A separate "Fine Arts Festival II" runs Sept 11–13 — do not merge.'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = 'The festival is on the Bar Harbor Inn grounds on the waterfront — not the Village Green. Fri noon–7pm, Sat 9am–7pm, Sun 10am–5pm. A separate "Fine Arts Festival II" runs Sept 11–13.'
WHERE id = 'f8b9d6ca-bb0d-4ccd-9961-3dab12843a96' AND access_notes = 'Organizer is artist Marc Fink (marcfink.com/shows), venue is the Bar Harbor Inn grounds on the waterfront — not the Village Green. Fri noon–7pm, Sat 9am–7pm, Sun 10am–5pm. A separate "Fine Arts Festival II" runs Sept 11–13 — do not merge.';

-- cmp-employee-club-vendor-and-craft-fair (prose)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] observed: employee-club fair at CMP corporate office (83 Edison Dr) — public access not confirmed in source email | when: Fri Nov 20, 10am-2pm | source: inbound email 6687326d (CMP Employee Club invite, 2026-09-02)', unixepoch(), unixepoch()
FROM events
WHERE id = 'c2389999-a82a-418d-88e6-f0d4b8d0e84e' AND access_notes = 'observed: employee-club fair at CMP corporate office (83 Edison Dr) — public access not confirmed in source email | when: Fri Nov 20, 10am-2pm | source: inbound email 6687326d (CMP Employee Club invite, 2026-09-02)'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = NULL
WHERE id = 'c2389999-a82a-418d-88e6-f0d4b8d0e84e' AND access_notes = 'observed: employee-club fair at CMP corporate office (83 Edison Dr) — public access not confirmed in source email | when: Fri Nov 20, 10am-2pm | source: inbound email 6687326d (CMP Employee Club invite, 2026-09-02)';

-- custom-bike-and-car-show-everett-arena-2026 (prose)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] 2026-08-03 sweep: 2026 date unverified — city schedule PDF is robots-blocked and the city events page shows stale 2023 text; 2025 edition ran Sat Aug 9. Plausible but ungrounded; needs the arena schedule PDF or a call to Concord General Services (603-225-8525).', unixepoch(), unixepoch()
FROM events
WHERE id = '2516bc68-f7b1-443f-b493-fee5dfef1c2a' AND access_notes = '2026-08-03 sweep: 2026 date unverified — city schedule PDF is robots-blocked and the city events page shows stale 2023 text; 2025 edition ran Sat Aug 9. Plausible but ungrounded; needs the arena schedule PDF or a call to Concord General Services (603-225-8525).'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = NULL
WHERE id = '2516bc68-f7b1-443f-b493-fee5dfef1c2a' AND access_notes = '2026-08-03 sweep: 2026 date unverified — city schedule PDF is robots-blocked and the city events page shows stale 2023 text; 2025 edition ran Sat Aug 9. Plausible but ungrounded; needs the arena schedule PDF or a call to Concord General Services (603-225-8525).';

-- greater-new-haven-chamber-big-connect-expo-2026 (mixed)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] Attendance is by registration through the chamber''s event page; ticket and booth prices were not readable at the time of entry.', unixepoch(), unixepoch()
FROM events
WHERE id = 'e92b7220-3feb-48a3-bfdc-ae1ca6171c50' AND access_notes = 'Attendance is by registration through the chamber''s event page; ticket and booth prices were not readable at the time of entry.'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = 'Attendance is by registration through the chamber''s event page.'
WHERE id = 'e92b7220-3feb-48a3-bfdc-ae1ca6171c50' AND access_notes = 'Attendance is by registration through the chamber''s event page; ticket and booth prices were not readable at the time of entry.';

-- holy-cross-lutheran-blueberry-festival-and-crafts-fair (prose)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] 2026-08-03 sweep: annual August event confirmed as a tradition, but no 2026 date published by the church (site says only "held annually in August"). Aug 8 is plausible (Saturday) but ungrounded — check facebook.com "Blueberry and Craft Fair in Kennebunk Maine" or call 207-985-4803.', unixepoch(), unixepoch()
FROM events
WHERE id = '2ef9e1da-0005-467c-8c33-57136c0fe32c' AND access_notes = '2026-08-03 sweep: annual August event confirmed as a tradition, but no 2026 date published by the church (site says only "held annually in August"). Aug 8 is plausible (Saturday) but ungrounded — check facebook.com "Blueberry and Craft Fair in Kennebunk Maine" or call 207-985-4803.'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = NULL
WHERE id = '2ef9e1da-0005-467c-8c33-57136c0fe32c' AND access_notes = '2026-08-03 sweep: annual August event confirmed as a tradition, but no 2026 date published by the church (site says only "held annually in August"). Aug 8 is plausible (Saturday) but ungrounded — check facebook.com "Blueberry and Craft Fair in Kennebunk Maine" or call 207-985-4803.';

-- maine-highland-games-and-scottish-festival-2026 (prose)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] VENUE CHECK: the 47th Games are at the Windsor Fair Grounds, Windsor, ME — verify our venue record isn''t pointing at Topsham (the Games moved from Topsham).', unixepoch(), unixepoch()
FROM events
WHERE id = '20d35f42-99bb-46f7-b127-ea53a99eb4f9' AND access_notes = 'VENUE CHECK: the 47th Games are at the Windsor Fair Grounds, Windsor, ME — verify our venue record isn''t pointing at Topsham (the Games moved from Topsham).'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = NULL
WHERE id = '20d35f42-99bb-46f7-b127-ea53a99eb4f9' AND access_notes = 'VENUE CHECK: the 47th Games are at the Windsor Fair Grounds, Windsor, ME — verify our venue record isn''t pointing at Topsham (the Games moved from Topsham).';

-- new-england-made-giftware-specialty-food-show-autumn (mixed)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] Trade-only juried wholesale show — NOT open to the general public. Qualified wholesale buyers of giftware, specialty food, or home furnishings only; buyer registration required, with 2 forms of retail business ID at entry; no one under 16. (Per organizer newsletter, New England Made / Giraffe Events LLC, 2026-07-27; OPE-272 W2 value-recall audit capture. Re-confirmed against the organizer''s own Autumn Show page, nemadeshows.com/autumn-show, 2026-09-14.)', unixepoch(), unixepoch()
FROM events
WHERE id = 'defe4089-6065-4d29-bfae-dbd1285c099e' AND access_notes = 'Trade-only juried wholesale show — NOT open to the general public. Qualified wholesale buyers of giftware, specialty food, or home furnishings only; buyer registration required, with 2 forms of retail business ID at entry; no one under 16. (Per organizer newsletter, New England Made / Giraffe Events LLC, 2026-07-27; OPE-272 W2 value-recall audit capture. Re-confirmed against the organizer''s own Autumn Show page, nemadeshows.com/autumn-show, 2026-09-14.)'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = 'Trade-only juried wholesale show — NOT open to the general public. Qualified wholesale buyers of giftware, specialty food, or home furnishings only; buyer registration required, with 2 forms of retail business ID at entry; no one under 16.'
WHERE id = 'defe4089-6065-4d29-bfae-dbd1285c099e' AND access_notes = 'Trade-only juried wholesale show — NOT open to the general public. Qualified wholesale buyers of giftware, specialty food, or home furnishings only; buyer registration required, with 2 forms of retail business ID at entry; no one under 16. (Per organizer newsletter, New England Made / Giraffe Events LLC, 2026-07-27; OPE-272 W2 value-recall audit capture. Re-confirmed against the organizer''s own Autumn Show page, nemadeshows.com/autumn-show, 2026-09-14.)';

-- north-shore-vendor-events-summer-vendor-fair-middleton (prose)
INSERT INTO event_internal_notes (event_id, notes, created_at, updated_at)
SELECT id, '[OPE-1151 2026-10-15: moved verbatim from access_notes, which now renders publicly] 2026-08-03 sweep: Aug 8 date unverifiable — NSV''s own listings page is JS-only and no third-party NSV listing (Eventbrite, FestivalNet) shows an Aug 8 Middleton fair. Needs manual check of nsvevents.com or their Facebook.', unixepoch(), unixepoch()
FROM events
WHERE id = '9422e8f6-8262-4fd5-a3d4-53a04c511fe8' AND access_notes = '2026-08-03 sweep: Aug 8 date unverifiable — NSV''s own listings page is JS-only and no third-party NSV listing (Eventbrite, FestivalNet) shows an Aug 8 Middleton fair. Needs manual check of nsvevents.com or their Facebook.'
ON CONFLICT(event_id) DO UPDATE SET
  notes = event_internal_notes.notes || char(10) || char(10) || excluded.notes,
  updated_at = excluded.updated_at;
UPDATE events SET access_notes = NULL
WHERE id = '9422e8f6-8262-4fd5-a3d4-53a04c511fe8' AND access_notes = '2026-08-03 sweep: Aug 8 date unverifiable — NSV''s own listings page is JS-only and no third-party NSV listing (Eventbrite, FestivalNet) shows an Aug 8 Middleton fair. Needs manual check of nsvevents.com or their Facebook.';

-- ROLLBACK (restores each original verbatim; guarded so it only reverts a row
-- this migration changed and nobody has edited since). Then, optionally:
--   DELETE FROM event_internal_notes WHERE notes LIKE '[OPE-1151%';
-- (Leave the table in place — dropping it would lose any later writes.)
-- UPDATE events SET access_notes = '2026-08-03 sweep: TWO issues. (1) Venue: event is at Asbury United Methodist Church, 90 Church Ave, Forestville — Bristol CONNECTICUT, not Bristol RI; verify/fix our venue record. (2) 2026 appears scaled down to a "Blueberry Breakfast and Bake Sale" (FestivalNet listing has garbled dates); 2025 pattern was 2nd Saturday. Needs organizer confirmation (860-584-0529).'
--   WHERE id = '80478d42-ea97-42d8-9bdc-8fd2c4a202ad' AND access_notes IS NULL;
-- UPDATE events SET access_notes = 'Organizer is artist Marc Fink (marcfink.com/shows), venue is the Bar Harbor Inn grounds on the waterfront — not the Village Green. Fri noon–7pm, Sat 9am–7pm, Sun 10am–5pm. A separate "Fine Arts Festival II" runs Sept 11–13 — do not merge.'
--   WHERE id = 'f8b9d6ca-bb0d-4ccd-9961-3dab12843a96' AND access_notes IS 'The festival is on the Bar Harbor Inn grounds on the waterfront — not the Village Green. Fri noon–7pm, Sat 9am–7pm, Sun 10am–5pm. A separate "Fine Arts Festival II" runs Sept 11–13.';
-- UPDATE events SET access_notes = 'observed: employee-club fair at CMP corporate office (83 Edison Dr) — public access not confirmed in source email | when: Fri Nov 20, 10am-2pm | source: inbound email 6687326d (CMP Employee Club invite, 2026-09-02)'
--   WHERE id = 'c2389999-a82a-418d-88e6-f0d4b8d0e84e' AND access_notes IS NULL;
-- UPDATE events SET access_notes = '2026-08-03 sweep: 2026 date unverified — city schedule PDF is robots-blocked and the city events page shows stale 2023 text; 2025 edition ran Sat Aug 9. Plausible but ungrounded; needs the arena schedule PDF or a call to Concord General Services (603-225-8525).'
--   WHERE id = '2516bc68-f7b1-443f-b493-fee5dfef1c2a' AND access_notes IS NULL;
-- UPDATE events SET access_notes = 'Attendance is by registration through the chamber''s event page; ticket and booth prices were not readable at the time of entry.'
--   WHERE id = 'e92b7220-3feb-48a3-bfdc-ae1ca6171c50' AND access_notes IS 'Attendance is by registration through the chamber''s event page.';
-- UPDATE events SET access_notes = '2026-08-03 sweep: annual August event confirmed as a tradition, but no 2026 date published by the church (site says only "held annually in August"). Aug 8 is plausible (Saturday) but ungrounded — check facebook.com "Blueberry and Craft Fair in Kennebunk Maine" or call 207-985-4803.'
--   WHERE id = '2ef9e1da-0005-467c-8c33-57136c0fe32c' AND access_notes IS NULL;
-- UPDATE events SET access_notes = 'VENUE CHECK: the 47th Games are at the Windsor Fair Grounds, Windsor, ME — verify our venue record isn''t pointing at Topsham (the Games moved from Topsham).'
--   WHERE id = '20d35f42-99bb-46f7-b127-ea53a99eb4f9' AND access_notes IS NULL;
-- UPDATE events SET access_notes = 'Trade-only juried wholesale show — NOT open to the general public. Qualified wholesale buyers of giftware, specialty food, or home furnishings only; buyer registration required, with 2 forms of retail business ID at entry; no one under 16. (Per organizer newsletter, New England Made / Giraffe Events LLC, 2026-07-27; OPE-272 W2 value-recall audit capture. Re-confirmed against the organizer''s own Autumn Show page, nemadeshows.com/autumn-show, 2026-09-14.)'
--   WHERE id = 'defe4089-6065-4d29-bfae-dbd1285c099e' AND access_notes IS 'Trade-only juried wholesale show — NOT open to the general public. Qualified wholesale buyers of giftware, specialty food, or home furnishings only; buyer registration required, with 2 forms of retail business ID at entry; no one under 16.';
-- UPDATE events SET access_notes = '2026-08-03 sweep: Aug 8 date unverifiable — NSV''s own listings page is JS-only and no third-party NSV listing (Eventbrite, FestivalNet) shows an Aug 8 Middleton fair. Needs manual check of nsvevents.com or their Facebook.'
--   WHERE id = '9422e8f6-8262-4fd5-a3d4-53a04c511fe8' AND access_notes IS NULL;

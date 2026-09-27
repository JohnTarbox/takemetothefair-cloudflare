-- OPE-1171 — split gallery `caption` into a public caption and an internal
-- `source_note`.
--
-- Until now no gallery rendered captions in its grid, so `caption` quietly
-- became the place provenance went. Rendering it (the point of OPE-1171)
-- would publish that provenance on a maker's or a fair's public page. Read on
-- prod 2026-09-27, every live caption across both tables (28 rows):
--
--   * 1 vendor row mixes both: a description, then "From vendor's Facebook
--     page, 2026-09-22". Split: description stays, provenance moves.
--   * 10 event rows are provenance only — nine "Waterford World's Fair
--     2026-07-17 (OPE-254 rescue)" and one "OPE-314/321 review probe …".
--     Moved whole; the caption becomes NULL and the alt falls back to
--     "Photo from <event>".
--   * The other 17 are real captions and are left alone.
--
-- `source_note` is never selected by a public reader (both gallery readers
-- select explicit columns). Every UPDATE matches on id AND the exact current
-- caption, so it is idempotent, cannot touch a row someone has since edited,
-- and is a no-op on an empty database. See docs/bulk-mutation-discipline.md.

ALTER TABLE vendor_photos ADD COLUMN source_note TEXT;
ALTER TABLE event_photos ADD COLUMN source_note TEXT;

UPDATE vendor_photos
SET caption = '7th Star Bags booth — handmade art-panel totes, bucket bags and pouches.',
    source_note = 'From vendor''s Facebook page, 2026-09-22'
WHERE id = 'd2fd12a5-5235-46b9-9fc4-4033763b9ec1'
  AND caption = '7th Star Bags booth — handmade art-panel totes, bucket bags and pouches. From vendor''s Facebook page, 2026-09-22';

UPDATE event_photos
SET source_note = caption, caption = NULL
WHERE caption = 'Waterford World''s Fair 2026-07-17 (OPE-254 rescue)'
  AND id IN (
    'ope254-rescue-bdcdff66',
    'fe9a3db2-1478-4af4-bc1d-9cfaaaea74a6',
    '25c4a5d9-0544-4a8b-b489-f21e42fac164',
    '045bed8e-fcca-4d93-a205-02e7fcebedc1',
    '748bce49-8b79-4a4b-9f0d-ac24bc71bee3',
    '19dec783-021b-42d6-8412-caf719a796aa',
    '01de4e3b-5663-4d4c-aee9-d247f6a7d149',
    'd28d22b9-6b56-4fca-9b47-acc50e56198b',
    '4bfbba6a-5d86-47a4-8e30-77a24d529863'
  );

UPDATE event_photos
SET source_note = caption, caption = NULL
WHERE id = '459981c2-05cd-4b8e-8ee0-d0a029d28b4c'
  AND caption = 'OPE-314/321 review probe — testing minted host + WebP path (Bangor State Fair gallery; harmless if consumed)';

-- OPE-572 item 3 — decode the HTML entities in `event_days.notes`.
--
-- These render verbatim in the Dates block, so a stored `&amp;` reaches the
-- visitor as the literal text "&amp;". Twelve rows, every one an ampersand in
-- ordinary prose:
--
--   "Lumber Jack &amp; Jill competitions"
--   "Beer &amp; wine garden 5pm-10pm"
--   "4-H &amp; Agricultural Awareness Day"
--   "Bret Michaels &amp; Night Ranger"
--
-- Purely mechanical, unlike item 2 (see below) — there is no judgement in
-- turning `&amp;` into `&`, and no visitor-facing meaning is at risk.
--
-- ⚠️ `&amp;` is decoded LAST. Doing it first would double-decode: `&amp;quot;`
-- would become `&quot;` and then `"`, silently changing text that was correctly
-- escaped once.
--
-- Idempotent: each UPDATE is guarded on the entity still being present, so
-- re-applying is a no-op, and it is a clean no-op against the empty D1 that CI
-- builds from migrations.
--
-- The write side is fixed too — `create_event_day` / `update_event_day` now
-- `.transform(decodeHtmlEntities)` on `notes`, so this class cannot re-enter
-- through the tools that produced it.
UPDATE event_days SET notes = replace(notes, '&quot;', '"')
 WHERE notes LIKE '%&quot;%';
UPDATE event_days SET notes = replace(notes, '&#39;', '''')
 WHERE notes LIKE '%&#39;%';
UPDATE event_days SET notes = replace(notes, '&apos;', '''')
 WHERE notes LIKE '%&apos;%';
UPDATE event_days SET notes = replace(notes, '&lt;', '<')
 WHERE notes LIKE '%&lt;%';
UPDATE event_days SET notes = replace(notes, '&gt;', '>')
 WHERE notes LIKE '%&gt;%';
UPDATE event_days SET notes = replace(notes, '&amp;', '&')
 WHERE notes LIKE '%&amp;%';

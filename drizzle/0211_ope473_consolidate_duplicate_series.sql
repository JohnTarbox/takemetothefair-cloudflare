-- OPE-473 — consolidate duplicate `event_series` parents. John approved the bulk
-- run 2026-08-19; the grouping-key fix that stops it recurring shipped in #936.
--
-- 116 groups, 123 duplicate parents retired, 123 events re-parented.
--
-- WHY A MIGRATION: docs/bulk-mutation-discipline.md wants one writer. A migration
-- is single-writer by construction and idempotent by construction — d1_migrations
-- records it, and every statement below is independently re-runnable anyway
-- (INSERT OR IGNORE / idempotent UPDATE / DELETE of an absent row is a no-op).
--
-- ORDER WITHIN EACH PAIR IS LOAD-BEARING: history row, re-parent, THEN delete.
-- `events.series_id` is ON DELETE SET NULL, so deleting the parent first would
-- silently orphan its children rather than failing loudly.
--
-- KEEPER RULE: `canonical_slug == createSlug(name)` (115 groups), falling back to
-- the shortest slug only where every sibling extends it (1 group). Shortest-wins
-- alone would have been WRONG on 3 of the 5 slug-drift groups, because
-- createSlug expands `&` to "and" and the canonical form is the LONGER slug.
--
-- EXCLUDED, deliberately:
--   * 9 per-date farmers-market groups (211 rows) — K18 says the target shape is
--     1 series -> 1 event -> N event_days; a separate migration, not this one.
--   * Martha's Vineyard Fair — NEITHER row carries the canonical slug
--     (`marthas-vineyard-fair`), so picking between two non-canonical forms is a
--     permanent slug decision and not one to automate. Left for John.
--
-- No event slug is renamed. Only `events.series_id` changes, plus the redirect
-- rows that keep the retired hubs reachable.
--
-- ROLLBACK: docs/ope473/pre-change-series-dump.json holds all 241 pre-change
-- parent rows; docs/ope473/rollback.sql re-inserts the 123 deleted ones. The
-- event->series reverse map is in the same dump directory.
-- 116 groups, 123 duplicates retired.

-- Acton Fair  (keeper: acton-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '37d36258e7f6b929e89ac344d62a5a50', 'acton-fair-me', 'acton-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '37d36258e7f6b929e89ac344d62a5a50');
UPDATE events SET series_id = '37d36258e7f6b929e89ac344d62a5a50', updated_at = unixepoch() WHERE series_id = 'a3dd595d79ec2ec831758a4a11f9421e' AND EXISTS (SELECT 1 FROM event_series WHERE id = '37d36258e7f6b929e89ac344d62a5a50');
DELETE FROM event_series WHERE id = 'a3dd595d79ec2ec831758a4a11f9421e';

-- Bangor State Fair  (keeper: bangor-state-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '907f7fc7de8a2f37a231373d52beb871', 'bangor-state-fair-me', 'bangor-state-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '907f7fc7de8a2f37a231373d52beb871');
UPDATE events SET series_id = '907f7fc7de8a2f37a231373d52beb871', updated_at = unixepoch() WHERE series_id = '7a8ce9c5c6d0ba58f51c117002f118f1' AND EXISTS (SELECT 1 FROM event_series WHERE id = '907f7fc7de8a2f37a231373d52beb871');
DELETE FROM event_series WHERE id = '7a8ce9c5c6d0ba58f51c117002f118f1';

-- Bass Park After Dark  (keeper: bass-park-after-dark, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a14a898821aa88423b60bfd7602e005e', 'bass-park-after-dark-1', 'bass-park-after-dark', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a14a898821aa88423b60bfd7602e005e');
UPDATE events SET series_id = 'a14a898821aa88423b60bfd7602e005e', updated_at = unixepoch() WHERE series_id = 'f8f3248e44791c08c9afea3ff5ff3e6e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a14a898821aa88423b60bfd7602e005e');
DELETE FROM event_series WHERE id = 'f8f3248e44791c08c9afea3ff5ff3e6e';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a14a898821aa88423b60bfd7602e005e', 'bass-park-after-dark-2', 'bass-park-after-dark', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a14a898821aa88423b60bfd7602e005e');
UPDATE events SET series_id = 'a14a898821aa88423b60bfd7602e005e', updated_at = unixepoch() WHERE series_id = '80997c9b34a9eb521e35c41e0e75070e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a14a898821aa88423b60bfd7602e005e');
DELETE FROM event_series WHERE id = '80997c9b34a9eb521e35c41e0e75070e';

-- Belknap County 4-H Fair  (keeper: belknap-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '753fcbac1a58a78663148fb31f0d45b3', 'belknap-county-4-h-fair-nh', 'belknap-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '753fcbac1a58a78663148fb31f0d45b3');
UPDATE events SET series_id = '753fcbac1a58a78663148fb31f0d45b3', updated_at = unixepoch() WHERE series_id = 'aad8cdf29e0b0ee07db1d25a0fc44c97' AND EXISTS (SELECT 1 FROM event_series WHERE id = '753fcbac1a58a78663148fb31f0d45b3');
DELETE FROM event_series WHERE id = 'aad8cdf29e0b0ee07db1d25a0fc44c97';

-- Bethlehem Fair  (keeper: bethlehem-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '6767ad7696b9dde258677cb50954f724', 'bethlehem-fair-ct', 'bethlehem-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '6767ad7696b9dde258677cb50954f724');
UPDATE events SET series_id = '6767ad7696b9dde258677cb50954f724', updated_at = unixepoch() WHERE series_id = '22df4bb9b404484e6d347a7ad9ee729c' AND EXISTS (SELECT 1 FROM event_series WHERE id = '6767ad7696b9dde258677cb50954f724');
DELETE FROM event_series WHERE id = '22df4bb9b404484e6d347a7ad9ee729c';

-- Blandford Fair  (keeper: blandford-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'cd92890da96ab27cd268aec8ff3720a4', 'blandford-fair-ma', 'blandford-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'cd92890da96ab27cd268aec8ff3720a4');
UPDATE events SET series_id = 'cd92890da96ab27cd268aec8ff3720a4', updated_at = unixepoch() WHERE series_id = 'b757dfd9b46386e1dd5cca3b39d3464e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'cd92890da96ab27cd268aec8ff3720a4');
DELETE FROM event_series WHERE id = 'b757dfd9b46386e1dd5cca3b39d3464e';

-- Blue Hill Fair  (keeper: blue-hill-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '331bbbd42e1c2ba7681a380fc294a74e', 'blue-hill-fair-me', 'blue-hill-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '331bbbd42e1c2ba7681a380fc294a74e');
UPDATE events SET series_id = '331bbbd42e1c2ba7681a380fc294a74e', updated_at = unixepoch() WHERE series_id = 'abb8abbb1e0d484592fa560be5fd8768' AND EXISTS (SELECT 1 FROM event_series WHERE id = '331bbbd42e1c2ba7681a380fc294a74e');
DELETE FROM event_series WHERE id = 'abb8abbb1e0d484592fa560be5fd8768';

-- Bonny Eagle Craft Fair  (keeper: bonny-eagle-craft-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '92c001fc0ef8d1e3c3d6f5c27f828972', 'bonny-eagle-craft-fair-2026-1', 'bonny-eagle-craft-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '92c001fc0ef8d1e3c3d6f5c27f828972');
UPDATE events SET series_id = '92c001fc0ef8d1e3c3d6f5c27f828972', updated_at = unixepoch() WHERE series_id = '93e29dfb4358f2f0691b05e1bc2fffa1' AND EXISTS (SELECT 1 FROM event_series WHERE id = '92c001fc0ef8d1e3c3d6f5c27f828972');
DELETE FROM event_series WHERE id = '93e29dfb4358f2f0691b05e1bc2fffa1';

-- Boston Marathon  (keeper: boston-marathon, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'f64a10d16b334a3dbd23c19bb12fb934', 'boston-marathon-2026-1', 'boston-marathon', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'f64a10d16b334a3dbd23c19bb12fb934');
UPDATE events SET series_id = 'f64a10d16b334a3dbd23c19bb12fb934', updated_at = unixepoch() WHERE series_id = '5e1fa577ba34be70b95ce6b8d98bf30d' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'f64a10d16b334a3dbd23c19bb12fb934');
DELETE FROM event_series WHERE id = '5e1fa577ba34be70b95ce6b8d98bf30d';

-- Boston Pride for the People  (keeper: boston-pride-for-the-people, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'f87eba0b03983276d685547e1db61089', 'boston-pride-for-the-people-2026-1', 'boston-pride-for-the-people', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'f87eba0b03983276d685547e1db61089');
UPDATE events SET series_id = 'f87eba0b03983276d685547e1db61089', updated_at = unixepoch() WHERE series_id = '5513a3ff31b945aaa32919c967c2b0c7' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'f87eba0b03983276d685547e1db61089');
DELETE FROM event_series WHERE id = '5513a3ff31b945aaa32919c967c2b0c7';

-- Bridgewater Country Fair  (keeper: bridgewater-country-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '93fe8f5ae4028f242a7ef186496c755c', 'bridgewater-country-fair-ct', 'bridgewater-country-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '93fe8f5ae4028f242a7ef186496c755c');
UPDATE events SET series_id = '93fe8f5ae4028f242a7ef186496c755c', updated_at = unixepoch() WHERE series_id = 'f49e04a8c962551e58f0851478ab4e79' AND EXISTS (SELECT 1 FROM event_series WHERE id = '93fe8f5ae4028f242a7ef186496c755c');
DELETE FROM event_series WHERE id = 'f49e04a8c962551e58f0851478ab4e79';

-- Brooklyn Fair  (keeper: brooklyn-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '11002ce1fa1794f7b1f8c806bf42cd2b', 'brooklyn-fair-ct', 'brooklyn-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '11002ce1fa1794f7b1f8c806bf42cd2b');
UPDATE events SET series_id = '11002ce1fa1794f7b1f8c806bf42cd2b', updated_at = unixepoch() WHERE series_id = '18f64dbef52798007b6fd5117c292e4b' AND EXISTS (SELECT 1 FROM event_series WHERE id = '11002ce1fa1794f7b1f8c806bf42cd2b');
DELETE FROM event_series WHERE id = '18f64dbef52798007b6fd5117c292e4b';

-- Caledonia County Fair  (keeper: caledonia-county-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'f3cd04e1cabba18cc8c158fef6e33994', 'caledonia-county-fair-vt', 'caledonia-county-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'f3cd04e1cabba18cc8c158fef6e33994');
UPDATE events SET series_id = 'f3cd04e1cabba18cc8c158fef6e33994', updated_at = unixepoch() WHERE series_id = '1056f0f43ab724fd25bf161b7e43ec19' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'f3cd04e1cabba18cc8c158fef6e33994');
DELETE FROM event_series WHERE id = '1056f0f43ab724fd25bf161b7e43ec19';

-- Cannon Grange Agricultural Fair  (keeper: cannon-grange-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '038cb92e69cdcf59d60103727db9e118', 'cannon-grange-agricultural-fair-ct', 'cannon-grange-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '038cb92e69cdcf59d60103727db9e118');
UPDATE events SET series_id = '038cb92e69cdcf59d60103727db9e118', updated_at = unixepoch() WHERE series_id = 'a2869f013fee5f4dd2a88258adeae152' AND EXISTS (SELECT 1 FROM event_series WHERE id = '038cb92e69cdcf59d60103727db9e118');
DELETE FROM event_series WHERE id = 'a2869f013fee5f4dd2a88258adeae152';

-- Cheshire Fair  (keeper: cheshire-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '53e7b7670eee75638944c5f25f4cb31e', 'cheshire-fair-nh', 'cheshire-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '53e7b7670eee75638944c5f25f4cb31e');
UPDATE events SET series_id = '53e7b7670eee75638944c5f25f4cb31e', updated_at = unixepoch() WHERE series_id = '1fe2b5e86d0ff6d04ff2b8a8a7111f71' AND EXISTS (SELECT 1 FROM event_series WHERE id = '53e7b7670eee75638944c5f25f4cb31e');
DELETE FROM event_series WHERE id = '1fe2b5e86d0ff6d04ff2b8a8a7111f71';

-- Cheshire Grange Community Fair  (keeper: cheshire-grange-community-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '1836964c647494a6d936ef5df8d8340f', 'cheshire-grange-community-fair-ct', 'cheshire-grange-community-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '1836964c647494a6d936ef5df8d8340f');
UPDATE events SET series_id = '1836964c647494a6d936ef5df8d8340f', updated_at = unixepoch() WHERE series_id = 'cc192b86c528a15ac2411c393268bacd' AND EXISTS (SELECT 1 FROM event_series WHERE id = '1836964c647494a6d936ef5df8d8340f');
DELETE FROM event_series WHERE id = 'cc192b86c528a15ac2411c393268bacd';

-- Chester Fair  (keeper: chester-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '45850373c4a19d0006f12aae7947b03c', 'chester-fair-ct', 'chester-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '45850373c4a19d0006f12aae7947b03c');
UPDATE events SET series_id = '45850373c4a19d0006f12aae7947b03c', updated_at = unixepoch() WHERE series_id = '223eee2d76ee68d3035d24481ecfecd0' AND EXISTS (SELECT 1 FROM event_series WHERE id = '45850373c4a19d0006f12aae7947b03c');
DELETE FROM event_series WHERE id = '223eee2d76ee68d3035d24481ecfecd0';

-- Clinton Lions Fair  (keeper: clinton-lions-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'f8db144143ecc8ec06c8ba98a6457945', 'clinton-lions-fair-me', 'clinton-lions-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'f8db144143ecc8ec06c8ba98a6457945');
UPDATE events SET series_id = 'f8db144143ecc8ec06c8ba98a6457945', updated_at = unixepoch() WHERE series_id = 'affcd5dd8fb28d0ee4dddd4c361bcafe' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'f8db144143ecc8ec06c8ba98a6457945');
DELETE FROM event_series WHERE id = 'affcd5dd8fb28d0ee4dddd4c361bcafe';

-- Common Ground Country Fair  (keeper: common-ground-country-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '997032d004b48e7b060e597d1084a1d1', 'common-ground-country-fair-me', 'common-ground-country-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '997032d004b48e7b060e597d1084a1d1');
UPDATE events SET series_id = '997032d004b48e7b060e597d1084a1d1', updated_at = unixepoch() WHERE series_id = '5425a872f07e88d3fb4afc9baff14540' AND EXISTS (SELECT 1 FROM event_series WHERE id = '997032d004b48e7b060e597d1084a1d1');
DELETE FROM event_series WHERE id = '5425a872f07e88d3fb4afc9baff14540';

-- Cornish Fair  (keeper: cornish-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '2bbe80163f82631b8f70cebdaaf78291', 'cornish-fair-nh', 'cornish-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '2bbe80163f82631b8f70cebdaaf78291');
UPDATE events SET series_id = '2bbe80163f82631b8f70cebdaaf78291', updated_at = unixepoch() WHERE series_id = 'e8132d9112244bf4db1f5f093314ea15' AND EXISTS (SELECT 1 FROM event_series WHERE id = '2bbe80163f82631b8f70cebdaaf78291');
DELETE FROM event_series WHERE id = 'e8132d9112244bf4db1f5f093314ea15';

-- Cumberland County Fair  (keeper: cumberland-county-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '7713e29607135784722081b7b70418e4', 'cumberland-county-fair-me', 'cumberland-county-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '7713e29607135784722081b7b70418e4');
UPDATE events SET series_id = '7713e29607135784722081b7b70418e4', updated_at = unixepoch() WHERE series_id = '35a42070fab59eccd893e36a54fd56b9' AND EXISTS (SELECT 1 FROM event_series WHERE id = '7713e29607135784722081b7b70418e4');
DELETE FROM event_series WHERE id = '35a42070fab59eccd893e36a54fd56b9';

-- Dartmouth Grange Fair  (keeper: dartmouth-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'd5829812489c4bee03c8563b98cb4ff3', 'dartmouth-grange-fair-ma', 'dartmouth-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'd5829812489c4bee03c8563b98cb4ff3');
UPDATE events SET series_id = 'd5829812489c4bee03c8563b98cb4ff3', updated_at = unixepoch() WHERE series_id = 'cc085284a4b30855520b41dd24ca1aa4' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'd5829812489c4bee03c8563b98cb4ff3');
DELETE FROM event_series WHERE id = 'cc085284a4b30855520b41dd24ca1aa4';

-- Deerfield Fair  (keeper: deerfield-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '46081af7cbc8470debd16e1500ed023e', 'deerfield-fair-nh', 'deerfield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '46081af7cbc8470debd16e1500ed023e');
UPDATE events SET series_id = '46081af7cbc8470debd16e1500ed023e', updated_at = unixepoch() WHERE series_id = 'b82637d63ee7bf8108045312c8ed3daf' AND EXISTS (SELECT 1 FROM event_series WHERE id = '46081af7cbc8470debd16e1500ed023e');
DELETE FROM event_series WHERE id = 'b82637d63ee7bf8108045312c8ed3daf';

-- Durham Fair  (keeper: durham-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '909f3c90b75f430ae381d6c5b1ec52ba', 'durham-fair-ct', 'durham-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '909f3c90b75f430ae381d6c5b1ec52ba');
UPDATE events SET series_id = '909f3c90b75f430ae381d6c5b1ec52ba', updated_at = unixepoch() WHERE series_id = 'aebb7650fe159cba62690abe21b974e7' AND EXISTS (SELECT 1 FROM event_series WHERE id = '909f3c90b75f430ae381d6c5b1ec52ba');
DELETE FROM event_series WHERE id = 'aebb7650fe159cba62690abe21b974e7';

-- East Middleboro 4-H Fair  (keeper: east-middleboro-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '9984351dcdfb8781d4cd204e845f9e00', 'east-middleboro-4-h-fair-ma', 'east-middleboro-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '9984351dcdfb8781d4cd204e845f9e00');
UPDATE events SET series_id = '9984351dcdfb8781d4cd204e845f9e00', updated_at = unixepoch() WHERE series_id = '65625fd29eeb898cbff6be39aa704d9d' AND EXISTS (SELECT 1 FROM event_series WHERE id = '9984351dcdfb8781d4cd204e845f9e00');
DELETE FROM event_series WHERE id = '65625fd29eeb898cbff6be39aa704d9d';

-- Eastern Rhode Island 4-H Country Fair  (keeper: eastern-rhode-island-4-h-country-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '129b8bd2b3c8640602ab245cc46a7bbc', 'eastern-rhode-island-4-h-country-fair-ri', 'eastern-rhode-island-4-h-country-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '129b8bd2b3c8640602ab245cc46a7bbc');
UPDATE events SET series_id = '129b8bd2b3c8640602ab245cc46a7bbc', updated_at = unixepoch() WHERE series_id = 'c8311b177c9024051c158006c8d9cc4b' AND EXISTS (SELECT 1 FROM event_series WHERE id = '129b8bd2b3c8640602ab245cc46a7bbc');
DELETE FROM event_series WHERE id = 'c8311b177c9024051c158006c8d9cc4b';

-- Ekonk Community Grange Fair  (keeper: ekonk-community-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '36af985c2fff9a1d4beed9fb05a9a3cc', 'ekonk-community-grange-fair-ct', 'ekonk-community-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '36af985c2fff9a1d4beed9fb05a9a3cc');
UPDATE events SET series_id = '36af985c2fff9a1d4beed9fb05a9a3cc', updated_at = unixepoch() WHERE series_id = '3a60b9bb1811be41367a4aecc440413d' AND EXISTS (SELECT 1 FROM event_series WHERE id = '36af985c2fff9a1d4beed9fb05a9a3cc');
DELETE FROM event_series WHERE id = '3a60b9bb1811be41367a4aecc440413d';

-- Fairfield County 4-H Fair  (keeper: fairfield-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '03b85e3199bf054a7093fe34b6a40cf4', 'fairfield-county-4-h-fair-ct', 'fairfield-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '03b85e3199bf054a7093fe34b6a40cf4');
UPDATE events SET series_id = '03b85e3199bf054a7093fe34b6a40cf4', updated_at = unixepoch() WHERE series_id = 'a98585d729bec8203b6bc7cc58f0004e' AND EXISTS (SELECT 1 FROM event_series WHERE id = '03b85e3199bf054a7093fe34b6a40cf4');
DELETE FROM event_series WHERE id = 'a98585d729bec8203b6bc7cc58f0004e';

-- Farmington Fair  (keeper: farmington-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'd31724a58a3db5f7497fd4d57109d123', 'farmington-fair-me', 'farmington-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'd31724a58a3db5f7497fd4d57109d123');
UPDATE events SET series_id = 'd31724a58a3db5f7497fd4d57109d123', updated_at = unixepoch() WHERE series_id = 'a1b609cce82379262e0b8c853c7f442e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'd31724a58a3db5f7497fd4d57109d123');
DELETE FROM event_series WHERE id = 'a1b609cce82379262e0b8c853c7f442e';

-- Four Town Fair  (keeper: four-town-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3e40bb0c54e9b216e826aee1dea00232', 'four-town-fair-ct', 'four-town-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3e40bb0c54e9b216e826aee1dea00232');
UPDATE events SET series_id = '3e40bb0c54e9b216e826aee1dea00232', updated_at = unixepoch() WHERE series_id = '6148ecc93c24b740582541b2dc374a32' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3e40bb0c54e9b216e826aee1dea00232');
DELETE FROM event_series WHERE id = '6148ecc93c24b740582541b2dc374a32';

-- Franklin County Fair  (keeper: franklin-county-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '63bb2870468898067fe05c393115d8b5', 'franklin-county-fair-ma', 'franklin-county-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '63bb2870468898067fe05c393115d8b5');
UPDATE events SET series_id = '63bb2870468898067fe05c393115d8b5', updated_at = unixepoch() WHERE series_id = '1e3d6ef232932859bcc71e7365ef843e' AND EXISTS (SELECT 1 FROM event_series WHERE id = '63bb2870468898067fe05c393115d8b5');
DELETE FROM event_series WHERE id = '1e3d6ef232932859bcc71e7365ef843e';

-- Franklin County Field Days  (keeper: franklin-county-field-days, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '98e1ec0e976c2408c2d9c0e987d8542d', 'franklin-county-field-days-vt', 'franklin-county-field-days', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '98e1ec0e976c2408c2d9c0e987d8542d');
UPDATE events SET series_id = '98e1ec0e976c2408c2d9c0e987d8542d', updated_at = unixepoch() WHERE series_id = '80835d37cb1efd004def3bd4a213aef4' AND EXISTS (SELECT 1 FROM event_series WHERE id = '98e1ec0e976c2408c2d9c0e987d8542d');
DELETE FROM event_series WHERE id = '80835d37cb1efd004def3bd4a213aef4';

-- Fryeburg Fair  (keeper: fryeburg-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '243ea7066b62d402fedfe35e56bd0244', 'fryeburg-fair-me', 'fryeburg-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '243ea7066b62d402fedfe35e56bd0244');
UPDATE events SET series_id = '243ea7066b62d402fedfe35e56bd0244', updated_at = unixepoch() WHERE series_id = '96fe87a5a8fc2bf40949a723979b83c5' AND EXISTS (SELECT 1 FROM event_series WHERE id = '243ea7066b62d402fedfe35e56bd0244');
DELETE FROM event_series WHERE id = '96fe87a5a8fc2bf40949a723979b83c5';

-- Goshen Fair  (keeper: goshen-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '8bfc80fdda3a3c16d4b961261a87b963', 'goshen-fair-ct', 'goshen-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '8bfc80fdda3a3c16d4b961261a87b963');
UPDATE events SET series_id = '8bfc80fdda3a3c16d4b961261a87b963', updated_at = unixepoch() WHERE series_id = 'b98e0062c373bef5d3252047d6cfd6b4' AND EXISTS (SELECT 1 FROM event_series WHERE id = '8bfc80fdda3a3c16d4b961261a87b963');
DELETE FROM event_series WHERE id = 'b98e0062c373bef5d3252047d6cfd6b4';

-- Granby Grange Agricultural Fair  (keeper: granby-grange-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'c7b3d2f83c77522092add5a5b95595db', 'granby-grange-agricultural-fair-ct', 'granby-grange-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'c7b3d2f83c77522092add5a5b95595db');
UPDATE events SET series_id = 'c7b3d2f83c77522092add5a5b95595db', updated_at = unixepoch() WHERE series_id = '0bad4430a8ff531ab2e428fc809a3059' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'c7b3d2f83c77522092add5a5b95595db');
DELETE FROM event_series WHERE id = '0bad4430a8ff531ab2e428fc809a3059';

-- Granite State Fair  (keeper: granite-state-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a872eddddde371a0efdfa828fc8ec9a0', 'granite-state-fair-nh', 'granite-state-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a872eddddde371a0efdfa828fc8ec9a0');
UPDATE events SET series_id = 'a872eddddde371a0efdfa828fc8ec9a0', updated_at = unixepoch() WHERE series_id = 'e737df999e76fc5960fa434574700662' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a872eddddde371a0efdfa828fc8ec9a0');
DELETE FROM event_series WHERE id = 'e737df999e76fc5960fa434574700662';

-- Greenfield Hill Grange Fair  (keeper: greenfield-hill-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3ff6bb6d6507b2c64166629850fbabdb', 'greenfield-hill-grange-fair-ct', 'greenfield-hill-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3ff6bb6d6507b2c64166629850fbabdb');
UPDATE events SET series_id = '3ff6bb6d6507b2c64166629850fbabdb', updated_at = unixepoch() WHERE series_id = '1012830c3a5c4f9262f15fcd6870a646' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3ff6bb6d6507b2c64166629850fbabdb');
DELETE FROM event_series WHERE id = '1012830c3a5c4f9262f15fcd6870a646';

-- Hamburg Fair  (keeper: hamburg-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'e709bc82e2d2a3d9b78e08bf38e880e9', 'hamburg-fair-ct', 'hamburg-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'e709bc82e2d2a3d9b78e08bf38e880e9');
UPDATE events SET series_id = 'e709bc82e2d2a3d9b78e08bf38e880e9', updated_at = unixepoch() WHERE series_id = 'd7aa68ab5cc0c487b0ddcc3eec707d8e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'e709bc82e2d2a3d9b78e08bf38e880e9');
DELETE FROM event_series WHERE id = 'd7aa68ab5cc0c487b0ddcc3eec707d8e';

-- Hampden County 4-H Fair  (keeper: hampden-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'c60ac5d09c7dce952bab75dbf411e515', 'hampden-county-4-h-fair-ma', 'hampden-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'c60ac5d09c7dce952bab75dbf411e515');
UPDATE events SET series_id = 'c60ac5d09c7dce952bab75dbf411e515', updated_at = unixepoch() WHERE series_id = 'c0273013c161f196efec35767a5c7f8f' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'c60ac5d09c7dce952bab75dbf411e515');
DELETE FROM event_series WHERE id = 'c0273013c161f196efec35767a5c7f8f';

-- Hampshire County 4-H Fair  (keeper: hampshire-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '5d8301f6940addc91676ed361ac7174d', 'hampshire-county-4-h-fair-ma', 'hampshire-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '5d8301f6940addc91676ed361ac7174d');
UPDATE events SET series_id = '5d8301f6940addc91676ed361ac7174d', updated_at = unixepoch() WHERE series_id = 'e963dadddcfd0687a1f2cd6728abd62f' AND EXISTS (SELECT 1 FROM event_series WHERE id = '5d8301f6940addc91676ed361ac7174d');
DELETE FROM event_series WHERE id = 'e963dadddcfd0687a1f2cd6728abd62f';

-- Hardwick Fair  (keeper: hardwick-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '977fa5461097021fb047defb75dbb1aa', 'hardwick-fair-ma', 'hardwick-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '977fa5461097021fb047defb75dbb1aa');
UPDATE events SET series_id = '977fa5461097021fb047defb75dbb1aa', updated_at = unixepoch() WHERE series_id = 'afbeaa0ff70624a1ff0bfc2e0a128423' AND EXISTS (SELECT 1 FROM event_series WHERE id = '977fa5461097021fb047defb75dbb1aa');
DELETE FROM event_series WHERE id = 'afbeaa0ff70624a1ff0bfc2e0a128423';

-- Harmony Free Fair  (keeper: harmony-free-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'f6971aab3823a050c43f634adc5c94f1', 'harmony-free-fair-me', 'harmony-free-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'f6971aab3823a050c43f634adc5c94f1');
UPDATE events SET series_id = 'f6971aab3823a050c43f634adc5c94f1', updated_at = unixepoch() WHERE series_id = '93e85e10df16d9df17a6c73ba824b4c7' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'f6971aab3823a050c43f634adc5c94f1');
DELETE FROM event_series WHERE id = '93e85e10df16d9df17a6c73ba824b4c7';

-- Hartford County 4-H Fair  (keeper: hartford-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'dbc464da3e165396c8b42919b2c44509', 'hartford-county-4-h-fair-ct', 'hartford-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'dbc464da3e165396c8b42919b2c44509');
UPDATE events SET series_id = 'dbc464da3e165396c8b42919b2c44509', updated_at = unixepoch() WHERE series_id = 'a10569663e9b035e26596ac0f40313c0' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'dbc464da3e165396c8b42919b2c44509');
DELETE FROM event_series WHERE id = 'a10569663e9b035e26596ac0f40313c0';

-- Heath Fair  (keeper: heath-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'd886398ea8d8639cc47b25e46ce9647a', 'heath-fair-ma', 'heath-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'd886398ea8d8639cc47b25e46ce9647a');
UPDATE events SET series_id = 'd886398ea8d8639cc47b25e46ce9647a', updated_at = unixepoch() WHERE series_id = '253d36b26c27d790780a7f4f136409e6' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'd886398ea8d8639cc47b25e46ce9647a');
DELETE FROM event_series WHERE id = '253d36b26c27d790780a7f4f136409e6';

-- Hebron Harvest Fair  (keeper: hebron-harvest-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '53ffc00c2d4f1dd1d7b7002fd1ba3cb7', 'hebron-harvest-fair-ct', 'hebron-harvest-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '53ffc00c2d4f1dd1d7b7002fd1ba3cb7');
UPDATE events SET series_id = '53ffc00c2d4f1dd1d7b7002fd1ba3cb7', updated_at = unixepoch() WHERE series_id = '42ab4c98862f6359a7d059677658e9ec' AND EXISTS (SELECT 1 FROM event_series WHERE id = '53ffc00c2d4f1dd1d7b7002fd1ba3cb7');
DELETE FROM event_series WHERE id = '42ab4c98862f6359a7d059677658e9ec';

-- Hillsborough County Agricultural Fair  (keeper: hillsborough-county-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4e69472a3aa09e013d1ca8a47561160d', 'hillsborough-county-agricultural-fair-nh', 'hillsborough-county-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4e69472a3aa09e013d1ca8a47561160d');
UPDATE events SET series_id = '4e69472a3aa09e013d1ca8a47561160d', updated_at = unixepoch() WHERE series_id = '914e271a27a6d295b0162f6dadd45229' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4e69472a3aa09e013d1ca8a47561160d');
DELETE FROM event_series WHERE id = '914e271a27a6d295b0162f6dadd45229';

-- Hillstown Grange Agricultural Fair  (keeper: hillstown-grange-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '32b85206f8ec8208227e7d41de45e85a', 'hillstown-grange-agricultural-fair-ct', 'hillstown-grange-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '32b85206f8ec8208227e7d41de45e85a');
UPDATE events SET series_id = '32b85206f8ec8208227e7d41de45e85a', updated_at = unixepoch() WHERE series_id = 'bc37a5e35f5050e5d0b59b68ab5befb3' AND EXISTS (SELECT 1 FROM event_series WHERE id = '32b85206f8ec8208227e7d41de45e85a');
DELETE FROM event_series WHERE id = 'bc37a5e35f5050e5d0b59b68ab5befb3';

-- Hopkinton State Fair  (keeper: hopkinton-state-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '01b93381f7a6137323eca8ae5456beef', 'hopkinton-state-fair-2026-1', 'hopkinton-state-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '01b93381f7a6137323eca8ae5456beef');
UPDATE events SET series_id = '01b93381f7a6137323eca8ae5456beef', updated_at = unixepoch() WHERE series_id = '1288ca0508d85e14ae1829f06467cb03' AND EXISTS (SELECT 1 FROM event_series WHERE id = '01b93381f7a6137323eca8ae5456beef');
DELETE FROM event_series WHERE id = '1288ca0508d85e14ae1829f06467cb03';

-- Houlton Fair  (keeper: houlton-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '2d7fc2da6d353aa30770210d93c37ed4', 'houlton-fair-me', 'houlton-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '2d7fc2da6d353aa30770210d93c37ed4');
UPDATE events SET series_id = '2d7fc2da6d353aa30770210d93c37ed4', updated_at = unixepoch() WHERE series_id = '6d5f1391e0b77d398829740158f889db' AND EXISTS (SELECT 1 FROM event_series WHERE id = '2d7fc2da6d353aa30770210d93c37ed4');
DELETE FROM event_series WHERE id = '6d5f1391e0b77d398829740158f889db';

-- Kennebunkport Christmas Prelude  (keeper: kennebunkport-christmas-prelude, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '6022f0ccabf13267f4c54aa9f46a601b', 'kennebunkport-christmas-prelude-2026-1', 'kennebunkport-christmas-prelude', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '6022f0ccabf13267f4c54aa9f46a601b');
UPDATE events SET series_id = '6022f0ccabf13267f4c54aa9f46a601b', updated_at = unixepoch() WHERE series_id = '1e6df13050de751b83ceb71852a47a20' AND EXISTS (SELECT 1 FROM event_series WHERE id = '6022f0ccabf13267f4c54aa9f46a601b');
DELETE FROM event_series WHERE id = '1e6df13050de751b83ceb71852a47a20';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '6022f0ccabf13267f4c54aa9f46a601b', 'kennebunkport-christmas-prelude-2026-2', 'kennebunkport-christmas-prelude', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '6022f0ccabf13267f4c54aa9f46a601b');
UPDATE events SET series_id = '6022f0ccabf13267f4c54aa9f46a601b', updated_at = unixepoch() WHERE series_id = '96473a60a106fdc7886ae7b35fd32061' AND EXISTS (SELECT 1 FROM event_series WHERE id = '6022f0ccabf13267f4c54aa9f46a601b');
DELETE FROM event_series WHERE id = '96473a60a106fdc7886ae7b35fd32061';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '6022f0ccabf13267f4c54aa9f46a601b', 'kennebunkport-christmas-prelude-2026-3', 'kennebunkport-christmas-prelude', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '6022f0ccabf13267f4c54aa9f46a601b');
UPDATE events SET series_id = '6022f0ccabf13267f4c54aa9f46a601b', updated_at = unixepoch() WHERE series_id = 'f4a2ed9a9944eceda8b3006d54963e91' AND EXISTS (SELECT 1 FROM event_series WHERE id = '6022f0ccabf13267f4c54aa9f46a601b');
DELETE FROM event_series WHERE id = 'f4a2ed9a9944eceda8b3006d54963e91';

-- Lamoille County Field Days  (keeper: lamoille-county-field-days, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'd51d01b951320430da4841b90d53f822', 'lamoille-county-field-days-vt', 'lamoille-county-field-days', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'd51d01b951320430da4841b90d53f822');
UPDATE events SET series_id = 'd51d01b951320430da4841b90d53f822', updated_at = unixepoch() WHERE series_id = '2531ed40852bcb2f92c17ba700428abe' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'd51d01b951320430da4841b90d53f822');
DELETE FROM event_series WHERE id = '2531ed40852bcb2f92c17ba700428abe';

-- Lancaster Fair  (keeper: lancaster-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'cc6639ee45dd16c14070d3ce5eb00b20', 'lancaster-fair-nh', 'lancaster-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'cc6639ee45dd16c14070d3ce5eb00b20');
UPDATE events SET series_id = 'cc6639ee45dd16c14070d3ce5eb00b20', updated_at = unixepoch() WHERE series_id = '929490d119bcccc60f54e25fe11463b1' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'cc6639ee45dd16c14070d3ce5eb00b20');
DELETE FROM event_series WHERE id = '929490d119bcccc60f54e25fe11463b1';

-- Lebanon Country Fair  (keeper: lebanon-country-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'e70f4c779b8be4c6ba0ebae0da23cb72', 'lebanon-country-fair-ct', 'lebanon-country-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'e70f4c779b8be4c6ba0ebae0da23cb72');
UPDATE events SET series_id = 'e70f4c779b8be4c6ba0ebae0da23cb72', updated_at = unixepoch() WHERE series_id = '0414532686dfa5d632f82b7edcb36fb1' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'e70f4c779b8be4c6ba0ebae0da23cb72');
DELETE FROM event_series WHERE id = '0414532686dfa5d632f82b7edcb36fb1';

-- Litchfield County 4-H Fair  (keeper: litchfield-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4dcd1a9c0e561954baa34a11ef03c207', 'litchfield-county-4-h-fair-ct', 'litchfield-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4dcd1a9c0e561954baa34a11ef03c207');
UPDATE events SET series_id = '4dcd1a9c0e561954baa34a11ef03c207', updated_at = unixepoch() WHERE series_id = '9ca28f9288517fc3098362598886a25f' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4dcd1a9c0e561954baa34a11ef03c207');
DELETE FROM event_series WHERE id = '9ca28f9288517fc3098362598886a25f';

-- Litchfield Fair  (keeper: litchfield-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '5c99191a18da0d4554c23806c1af02e9', 'litchfield-fair-me', 'litchfield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '5c99191a18da0d4554c23806c1af02e9');
UPDATE events SET series_id = '5c99191a18da0d4554c23806c1af02e9', updated_at = unixepoch() WHERE series_id = '6a662fd9bd54a836302c1fb4c4707545' AND EXISTS (SELECT 1 FROM event_series WHERE id = '5c99191a18da0d4554c23806c1af02e9');
DELETE FROM event_series WHERE id = '6a662fd9bd54a836302c1fb4c4707545';

-- Littleville Fair  (keeper: littleville-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'e399f6da32aea4365ed264356ba5fc40', 'littleville-fair-ma', 'littleville-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'e399f6da32aea4365ed264356ba5fc40');
UPDATE events SET series_id = 'e399f6da32aea4365ed264356ba5fc40', updated_at = unixepoch() WHERE series_id = 'e5fcfc6fc5201c1ebd55b6c8a552e813' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'e399f6da32aea4365ed264356ba5fc40');
DELETE FROM event_series WHERE id = 'e5fcfc6fc5201c1ebd55b6c8a552e813';

-- Maine Lobster Festival  (keeper: maine-lobster-festival, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4dd4b649d7714b0755c6edc043b2c819', 'maine-lobster-festival-2026-1', 'maine-lobster-festival', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4dd4b649d7714b0755c6edc043b2c819');
UPDATE events SET series_id = '4dd4b649d7714b0755c6edc043b2c819', updated_at = unixepoch() WHERE series_id = '1cedbbd70f9d8e73c088e903ea0aa8df' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4dd4b649d7714b0755c6edc043b2c819');
DELETE FROM event_series WHERE id = '1cedbbd70f9d8e73c088e903ea0aa8df';

-- Middlefield Fair  (keeper: middlefield-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '63a9efa8f0d3e7008177ae8c6e7d773e', 'middlefield-fair-ma', 'middlefield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '63a9efa8f0d3e7008177ae8c6e7d773e');
UPDATE events SET series_id = '63a9efa8f0d3e7008177ae8c6e7d773e', updated_at = unixepoch() WHERE series_id = '41de7600ba960f38b036414ae1306f88' AND EXISTS (SELECT 1 FROM event_series WHERE id = '63a9efa8f0d3e7008177ae8c6e7d773e');
DELETE FROM event_series WHERE id = '41de7600ba960f38b036414ae1306f88';

-- Middlesex & New Haven County 4-H Fair  (keeper: middlesex-and-new-haven-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '0f05df2a93936f2652dd3c67d359eb90', 'middlesex-and-new-haven-county-4-h-fair-ct', 'middlesex-and-new-haven-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '0f05df2a93936f2652dd3c67d359eb90');
UPDATE events SET series_id = '0f05df2a93936f2652dd3c67d359eb90', updated_at = unixepoch() WHERE series_id = '71c11ffecee3a2e80629dfa8f287d70d' AND EXISTS (SELECT 1 FROM event_series WHERE id = '0f05df2a93936f2652dd3c67d359eb90');
DELETE FROM event_series WHERE id = '71c11ffecee3a2e80629dfa8f287d70d';

-- Middlesex County 4-H Fair  (keeper: middlesex-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a94c048ca5b747117ac561944079dcbd', 'middlesex-county-4-h-fair-ma', 'middlesex-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a94c048ca5b747117ac561944079dcbd');
UPDATE events SET series_id = 'a94c048ca5b747117ac561944079dcbd', updated_at = unixepoch() WHERE series_id = '1d65f7910ce3ed52d337e6772fbb2196' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a94c048ca5b747117ac561944079dcbd');
DELETE FROM event_series WHERE id = '1d65f7910ce3ed52d337e6772fbb2196';

-- Monmouth Fair  (keeper: monmouth-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '126592b8b426523570bf6f9ced049da1', 'monmouth-fair-me', 'monmouth-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '126592b8b426523570bf6f9ced049da1');
UPDATE events SET series_id = '126592b8b426523570bf6f9ced049da1', updated_at = unixepoch() WHERE series_id = '801f880b6540f805cd04a11f3bf05127' AND EXISTS (SELECT 1 FROM event_series WHERE id = '126592b8b426523570bf6f9ced049da1');
DELETE FROM event_series WHERE id = '801f880b6540f805cd04a11f3bf05127';

-- New England Spring Craft Festival  (keeper: new-england-spring-craft-festival, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '0b20066461b5601355f5ce0f9c34fc66', 'new-england-spring-craft-festival-2026-1', 'new-england-spring-craft-festival', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '0b20066461b5601355f5ce0f9c34fc66');
UPDATE events SET series_id = '0b20066461b5601355f5ce0f9c34fc66', updated_at = unixepoch() WHERE series_id = 'f9b972690071010ab2d516744cfd7b56' AND EXISTS (SELECT 1 FROM event_series WHERE id = '0b20066461b5601355f5ce0f9c34fc66');
DELETE FROM event_series WHERE id = 'f9b972690071010ab2d516744cfd7b56';

-- New London County 4-H Expo & Fair  (keeper: new-london-county-4-h-expo-and-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4d75b93e70337463a0dcb868d2402e4a', 'new-london-county-4-h-expo-and-fair-ct', 'new-london-county-4-h-expo-and-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4d75b93e70337463a0dcb868d2402e4a');
UPDATE events SET series_id = '4d75b93e70337463a0dcb868d2402e4a', updated_at = unixepoch() WHERE series_id = '81411be1f31b56c6b607e99cd99eff9a' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4d75b93e70337463a0dcb868d2402e4a');
DELETE FROM event_series WHERE id = '81411be1f31b56c6b607e99cd99eff9a';

-- New Portland Lions Fair  (keeper: new-portland-lions-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'f6e8882acefa5611d023224f3404d0cf', 'new-portland-lions-fair-me', 'new-portland-lions-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'f6e8882acefa5611d023224f3404d0cf');
UPDATE events SET series_id = 'f6e8882acefa5611d023224f3404d0cf', updated_at = unixepoch() WHERE series_id = '9420418a6aab0ed061d4249c95d8790e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'f6e8882acefa5611d023224f3404d0cf');
DELETE FROM event_series WHERE id = '9420418a6aab0ed061d4249c95d8790e';

-- Newport International Boat Show  (keeper: newport-international-boat-show, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '8b72903ff619c59f56ca9177815b328a', 'newport-international-boat-show-2026-1', 'newport-international-boat-show', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '8b72903ff619c59f56ca9177815b328a');
UPDATE events SET series_id = '8b72903ff619c59f56ca9177815b328a', updated_at = unixepoch() WHERE series_id = '31a1bf0c30777c49b0ec9e1a2e657152' AND EXISTS (SELECT 1 FROM event_series WHERE id = '8b72903ff619c59f56ca9177815b328a');
DELETE FROM event_series WHERE id = '31a1bf0c30777c49b0ec9e1a2e657152';

-- NH Bacon & Beer Festival  (keeper: nh-bacon-and-beer-festival, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'c81c894598c303aabb1e1cf467e5fc8d', 'nh-bacon-beer-festival', 'nh-bacon-and-beer-festival', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'c81c894598c303aabb1e1cf467e5fc8d');
UPDATE events SET series_id = 'c81c894598c303aabb1e1cf467e5fc8d', updated_at = unixepoch() WHERE series_id = '7df6849b47e421aed36995d828a8c4d7' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'c81c894598c303aabb1e1cf467e5fc8d');
DELETE FROM event_series WHERE id = '7df6849b47e421aed36995d828a8c4d7';

-- NH Beer Trail Festival  (keeper: nh-beer-trail-festival, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '01626099cb789b78a4f60966b323a558', 'nh-beer-trail-festival-1', 'nh-beer-trail-festival', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '01626099cb789b78a4f60966b323a558');
UPDATE events SET series_id = '01626099cb789b78a4f60966b323a558', updated_at = unixepoch() WHERE series_id = 'e6354018fdd1be48a6d200dc6650f129' AND EXISTS (SELECT 1 FROM event_series WHERE id = '01626099cb789b78a4f60966b323a558');
DELETE FROM event_series WHERE id = 'e6354018fdd1be48a6d200dc6650f129';

-- Norfield Grange Agricultural Fair & Market  (keeper: norfield-grange-agricultural-fair-and-market, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '443dde2e2ad7ad035defb66f124ab3f5', 'norfield-grange-agricultural-fair-and-market-ct', 'norfield-grange-agricultural-fair-and-market', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '443dde2e2ad7ad035defb66f124ab3f5');
UPDATE events SET series_id = '443dde2e2ad7ad035defb66f124ab3f5', updated_at = unixepoch() WHERE series_id = '3c32aaffaba632b2d2269cb343194a2c' AND EXISTS (SELECT 1 FROM event_series WHERE id = '443dde2e2ad7ad035defb66f124ab3f5');
DELETE FROM event_series WHERE id = '3c32aaffaba632b2d2269cb343194a2c';

-- North Haven Fair  (keeper: north-haven-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '448c596cbf0792679a624f312a31b8fb', 'north-haven-fair-ct', 'north-haven-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '448c596cbf0792679a624f312a31b8fb');
UPDATE events SET series_id = '448c596cbf0792679a624f312a31b8fb', updated_at = unixepoch() WHERE series_id = 'd73d28b1fd2bbc40b948cb9cead469ba' AND EXISTS (SELECT 1 FROM event_series WHERE id = '448c596cbf0792679a624f312a31b8fb');
DELETE FROM event_series WHERE id = 'd73d28b1fd2bbc40b948cb9cead469ba';

-- North Haverhill Fair  (keeper: north-haverhill-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'ce54ac458b4e1b57cc67b4bbfc1a80d1', 'north-haverhill-fair-nh', 'north-haverhill-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'ce54ac458b4e1b57cc67b4bbfc1a80d1');
UPDATE events SET series_id = 'ce54ac458b4e1b57cc67b4bbfc1a80d1', updated_at = unixepoch() WHERE series_id = 'dd06d5d69df68fe1d8134ff22ebb657f' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'ce54ac458b4e1b57cc67b4bbfc1a80d1');
DELETE FROM event_series WHERE id = 'dd06d5d69df68fe1d8134ff22ebb657f';

-- North Stonington Agricultural Fair  (keeper: north-stonington-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4858917212a6e406ed0ef4f7fa88463b', 'north-stonington-agricultural-fair-ct', 'north-stonington-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4858917212a6e406ed0ef4f7fa88463b');
UPDATE events SET series_id = '4858917212a6e406ed0ef4f7fa88463b', updated_at = unixepoch() WHERE series_id = 'a16ed3a9494c05d7565d8c4846197800' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4858917212a6e406ed0ef4f7fa88463b');
DELETE FROM event_series WHERE id = 'a16ed3a9494c05d7565d8c4846197800';

-- Northern Maine Fair  (keeper: northern-maine-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '26f6384e66d15bd4cf58c79ff57ef1e9', 'northern-maine-fair-me', 'northern-maine-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '26f6384e66d15bd4cf58c79ff57ef1e9');
UPDATE events SET series_id = '26f6384e66d15bd4cf58c79ff57ef1e9', updated_at = unixepoch() WHERE series_id = '61f76eebed254987d310e9242b84d08a' AND EXISTS (SELECT 1 FROM event_series WHERE id = '26f6384e66d15bd4cf58c79ff57ef1e9');
DELETE FROM event_series WHERE id = '61f76eebed254987d310e9242b84d08a';

-- Orange Country Fair  (keeper: orange-country-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a9f6681269c4fb4c0a15141c4dc69d58', 'orange-country-fair-ct', 'orange-country-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a9f6681269c4fb4c0a15141c4dc69d58');
UPDATE events SET series_id = 'a9f6681269c4fb4c0a15141c4dc69d58', updated_at = unixepoch() WHERE series_id = '27b742d20e79de29f0afe7d922aebd9e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a9f6681269c4fb4c0a15141c4dc69d58');
DELETE FROM event_series WHERE id = '27b742d20e79de29f0afe7d922aebd9e';

-- Orleans County Fair  (keeper: orleans-county-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'bc19939eecc92fad9b73d7d2a6103f52', 'orleans-county-fair-vt', 'orleans-county-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'bc19939eecc92fad9b73d7d2a6103f52');
UPDATE events SET series_id = 'bc19939eecc92fad9b73d7d2a6103f52', updated_at = unixepoch() WHERE series_id = 'e08e158c63ccf341165d44385648832f' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'bc19939eecc92fad9b73d7d2a6103f52');
DELETE FROM event_series WHERE id = 'e08e158c63ccf341165d44385648832f';

-- Ossipee Valley Fair  (keeper: ossipee-valley-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3355088ccda7bbbc1212868dd0e2a454', 'ossipee-valley-fair-me', 'ossipee-valley-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3355088ccda7bbbc1212868dd0e2a454');
UPDATE events SET series_id = '3355088ccda7bbbc1212868dd0e2a454', updated_at = unixepoch() WHERE series_id = 'a0d803886c76862da49dc69a155981e1' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3355088ccda7bbbc1212868dd0e2a454');
DELETE FROM event_series WHERE id = 'a0d803886c76862da49dc69a155981e1';

-- Oxford Fair  (keeper: oxford-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'ed8cf092ff1ab935ca9e267a4392ec32', 'oxford-fair-me', 'oxford-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'ed8cf092ff1ab935ca9e267a4392ec32');
UPDATE events SET series_id = 'ed8cf092ff1ab935ca9e267a4392ec32', updated_at = unixepoch() WHERE series_id = 'e841fec2a1a039e3c9f66ddccd061492' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'ed8cf092ff1ab935ca9e267a4392ec32');
DELETE FROM event_series WHERE id = 'e841fec2a1a039e3c9f66ddccd061492';

-- Piscataquis Valley Fair  (keeper: piscataquis-valley-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '9ece9bda5aad7e9bf70921e932ae70e5', 'piscataquis-valley-fair-me', 'piscataquis-valley-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '9ece9bda5aad7e9bf70921e932ae70e5');
UPDATE events SET series_id = '9ece9bda5aad7e9bf70921e932ae70e5', updated_at = unixepoch() WHERE series_id = '1963891d9c59cafe8d633970c751bffc' AND EXISTS (SELECT 1 FROM event_series WHERE id = '9ece9bda5aad7e9bf70921e932ae70e5');
DELETE FROM event_series WHERE id = '1963891d9c59cafe8d633970c751bffc';

-- Pittston Fair  (keeper: pittston-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '48217d021a8248b27d2ac0504c0eab26', 'pittston-fair-me', 'pittston-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '48217d021a8248b27d2ac0504c0eab26');
UPDATE events SET series_id = '48217d021a8248b27d2ac0504c0eab26', updated_at = unixepoch() WHERE series_id = '92f0e7305735c4231626ec02477da11e' AND EXISTS (SELECT 1 FROM event_series WHERE id = '48217d021a8248b27d2ac0504c0eab26');
DELETE FROM event_series WHERE id = '92f0e7305735c4231626ec02477da11e';

-- Portland Agricultural Fair  (keeper: portland-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'faeeaf0bb8206767ac67c1ad55ced94a', 'portland-agricultural-fair-ct', 'portland-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'faeeaf0bb8206767ac67c1ad55ced94a');
UPDATE events SET series_id = 'faeeaf0bb8206767ac67c1ad55ced94a', updated_at = unixepoch() WHERE series_id = '3b5adf3bb5e7de01a236cee939bcc639' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'faeeaf0bb8206767ac67c1ad55ced94a');
DELETE FROM event_series WHERE id = '3b5adf3bb5e7de01a236cee939bcc639';

-- Riverton Fair  (keeper: riverton-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'b0d0bc43d1b373941a3c31897e63afc5', 'riverton-fair-ct', 'riverton-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'b0d0bc43d1b373941a3c31897e63afc5');
UPDATE events SET series_id = 'b0d0bc43d1b373941a3c31897e63afc5', updated_at = unixepoch() WHERE series_id = '30674abedf291331acd4f2e248b2111a' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'b0d0bc43d1b373941a3c31897e63afc5');
DELETE FROM event_series WHERE id = '30674abedf291331acd4f2e248b2111a';

-- Riverton Grange Fair  (keeper: riverton-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'e318c00656d84d7a35e80cd79bbd4ec9', 'riverton-grange-fair-ct', 'riverton-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'e318c00656d84d7a35e80cd79bbd4ec9');
UPDATE events SET series_id = 'e318c00656d84d7a35e80cd79bbd4ec9', updated_at = unixepoch() WHERE series_id = '5d3a6c8d9b7759526d8161fcce876550' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'e318c00656d84d7a35e80cd79bbd4ec9');
DELETE FROM event_series WHERE id = '5d3a6c8d9b7759526d8161fcce876550';

-- Sandwich Fair  (keeper: sandwich-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '0b8048765583e218fd9ac2a6cd8a32de', 'sandwich-fair-nh', 'sandwich-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '0b8048765583e218fd9ac2a6cd8a32de');
UPDATE events SET series_id = '0b8048765583e218fd9ac2a6cd8a32de', updated_at = unixepoch() WHERE series_id = '455682fe940854bf89a8026267a6520d' AND EXISTS (SELECT 1 FROM event_series WHERE id = '0b8048765583e218fd9ac2a6cd8a32de');
DELETE FROM event_series WHERE id = '455682fe940854bf89a8026267a6520d';

-- SE Connecticut Home & Garden Show  (keeper: se-connecticut-home-and-garden-show, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'ab3bc8f394cba66e7223826bb3c8afe7', 'se-connecticut-home-garden-show', 'se-connecticut-home-and-garden-show', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'ab3bc8f394cba66e7223826bb3c8afe7');
UPDATE events SET series_id = 'ab3bc8f394cba66e7223826bb3c8afe7', updated_at = unixepoch() WHERE series_id = 'e4f7f5f5590a40a43e125f2f42d1f384' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'ab3bc8f394cba66e7223826bb3c8afe7');
DELETE FROM event_series WHERE id = 'e4f7f5f5590a40a43e125f2f42d1f384';

-- Sheffield Fair  (keeper: sheffield-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'd82ccf55cd8b47944e8f761481c06e70', 'sheffield-fair-ma', 'sheffield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'd82ccf55cd8b47944e8f761481c06e70');
UPDATE events SET series_id = 'd82ccf55cd8b47944e8f761481c06e70', updated_at = unixepoch() WHERE series_id = '9ef86a09aa6a4f20bdf22a012a03eea9' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'd82ccf55cd8b47944e8f761481c06e70');
DELETE FROM event_series WHERE id = '9ef86a09aa6a4f20bdf22a012a03eea9';

-- Shelburne Grange Fair  (keeper: shelburne-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '7799db2adffef2000bc09ccdd31b4c23', 'shelburne-grange-fair-ma', 'shelburne-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '7799db2adffef2000bc09ccdd31b4c23');
UPDATE events SET series_id = '7799db2adffef2000bc09ccdd31b4c23', updated_at = unixepoch() WHERE series_id = 'dce8a6516699e256015cc93dd7b2eebd' AND EXISTS (SELECT 1 FROM event_series WHERE id = '7799db2adffef2000bc09ccdd31b4c23');
DELETE FROM event_series WHERE id = 'dce8a6516699e256015cc93dd7b2eebd';

-- Simsbury Grange Agricultural Fair  (keeper: simsbury-grange-agricultural-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '56e4e5cc1b9b51a35fd229e4c125f753', 'simsbury-grange-agricultural-fair-ct', 'simsbury-grange-agricultural-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '56e4e5cc1b9b51a35fd229e4c125f753');
UPDATE events SET series_id = '56e4e5cc1b9b51a35fd229e4c125f753', updated_at = unixepoch() WHERE series_id = 'b28722805ced69611e88ce9d85584257' AND EXISTS (SELECT 1 FROM event_series WHERE id = '56e4e5cc1b9b51a35fd229e4c125f753');
DELETE FROM event_series WHERE id = 'b28722805ced69611e88ce9d85584257';

-- Skowhegan State Fair  (keeper: skowhegan-state-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3ab574c018bb957fbf6ee67fb816dde2', 'skowhegan-state-fair-me', 'skowhegan-state-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3ab574c018bb957fbf6ee67fb816dde2');
UPDATE events SET series_id = '3ab574c018bb957fbf6ee67fb816dde2', updated_at = unixepoch() WHERE series_id = 'e5ba669bbaffacc1135940dfa8f6ed5f' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3ab574c018bb957fbf6ee67fb816dde2');
DELETE FROM event_series WHERE id = 'e5ba669bbaffacc1135940dfa8f6ed5f';

-- South Middleboro Grange Fair  (keeper: south-middleboro-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '24299e2341c18e66066321225344f6ac', 'south-middleboro-grange-fair-ma', 'south-middleboro-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '24299e2341c18e66066321225344f6ac');
UPDATE events SET series_id = '24299e2341c18e66066321225344f6ac', updated_at = unixepoch() WHERE series_id = '767b697fca5500c112b7f174a6e8572a' AND EXISTS (SELECT 1 FROM event_series WHERE id = '24299e2341c18e66066321225344f6ac');
DELETE FROM event_series WHERE id = '767b697fca5500c112b7f174a6e8572a';

-- Southern Rhode Island 4-H Fair  (keeper: southern-rhode-island-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'baf19ee95aaf4b34d6f5a1f74140fbf0', 'southern-rhode-island-4-h-fair-ri', 'southern-rhode-island-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'baf19ee95aaf4b34d6f5a1f74140fbf0');
UPDATE events SET series_id = 'baf19ee95aaf4b34d6f5a1f74140fbf0', updated_at = unixepoch() WHERE series_id = 'd9a38f6df14fcba95bdc0845baecf1ec' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'baf19ee95aaf4b34d6f5a1f74140fbf0');
DELETE FROM event_series WHERE id = 'd9a38f6df14fcba95bdc0845baecf1ec';

-- Spencer Fair  (keeper: spencer-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '7324ad384dc0f36add7f0c84abbc8e08', 'spencer-fair-ma', 'spencer-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '7324ad384dc0f36add7f0c84abbc8e08');
UPDATE events SET series_id = '7324ad384dc0f36add7f0c84abbc8e08', updated_at = unixepoch() WHERE series_id = 'c739efd91c668c5d4bea5754abecc90e' AND EXISTS (SELECT 1 FROM event_series WHERE id = '7324ad384dc0f36add7f0c84abbc8e08');
DELETE FROM event_series WHERE id = 'c739efd91c668c5d4bea5754abecc90e';

-- Springfield Fair  (keeper: springfield-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '7008b8d2b33a79b82194863f4781ff39', 'springfield-fair-1', 'springfield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '7008b8d2b33a79b82194863f4781ff39');
UPDATE events SET series_id = '7008b8d2b33a79b82194863f4781ff39', updated_at = unixepoch() WHERE series_id = '9a96a81f0019112ce22b5beb4744ef79' AND EXISTS (SELECT 1 FROM event_series WHERE id = '7008b8d2b33a79b82194863f4781ff39');
DELETE FROM event_series WHERE id = '9a96a81f0019112ce22b5beb4744ef79';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '7008b8d2b33a79b82194863f4781ff39', 'springfield-fair-me', 'springfield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '7008b8d2b33a79b82194863f4781ff39');
UPDATE events SET series_id = '7008b8d2b33a79b82194863f4781ff39', updated_at = unixepoch() WHERE series_id = '7cb7c4d9af7740da709a6656c685f1cb' AND EXISTS (SELECT 1 FROM event_series WHERE id = '7008b8d2b33a79b82194863f4781ff39');
DELETE FROM event_series WHERE id = '7cb7c4d9af7740da709a6656c685f1cb';

-- Stowe Foliage Arts Festival  (keeper: stowe-foliage-arts-festival, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '2e77f77e42a8cae43450e4e91d969f88', 'stowe-foliage-arts-festival-2026-1', 'stowe-foliage-arts-festival', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '2e77f77e42a8cae43450e4e91d969f88');
UPDATE events SET series_id = '2e77f77e42a8cae43450e4e91d969f88', updated_at = unixepoch() WHERE series_id = '44c19548d9484c93ee8d73ef416d1531' AND EXISTS (SELECT 1 FROM event_series WHERE id = '2e77f77e42a8cae43450e4e91d969f88');
DELETE FROM event_series WHERE id = '44c19548d9484c93ee8d73ef416d1531';

-- Stratham 4-H Summerfest  (keeper: stratham-4-h-summerfest, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '59aa279f5abc866ec867c495222174a8', 'stratham-4-h-summerfest-nh', 'stratham-4-h-summerfest', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '59aa279f5abc866ec867c495222174a8');
UPDATE events SET series_id = '59aa279f5abc866ec867c495222174a8', updated_at = unixepoch() WHERE series_id = 'fcb6c3d1d6d167972501833ba6389a03' AND EXISTS (SELECT 1 FROM event_series WHERE id = '59aa279f5abc866ec867c495222174a8');
DELETE FROM event_series WHERE id = 'fcb6c3d1d6d167972501833ba6389a03';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '59aa279f5abc866ec867c495222174a8', 'stratham-4-h-summerfest-2026-1', 'stratham-4-h-summerfest', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '59aa279f5abc866ec867c495222174a8');
UPDATE events SET series_id = '59aa279f5abc866ec867c495222174a8', updated_at = unixepoch() WHERE series_id = '1d46da0a35afa8fe842f87a5c8dd5aa8' AND EXISTS (SELECT 1 FROM event_series WHERE id = '59aa279f5abc866ec867c495222174a8');
DELETE FROM event_series WHERE id = '1d46da0a35afa8fe842f87a5c8dd5aa8';

-- Strawbery Banke Candlelight Stroll  (keeper: strawbery-banke-candlelight-stroll, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '5daa79bc3c162209f4347799a8e04a12', 'strawbery-banke-candlelight-stroll-2026-1', 'strawbery-banke-candlelight-stroll', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '5daa79bc3c162209f4347799a8e04a12');
UPDATE events SET series_id = '5daa79bc3c162209f4347799a8e04a12', updated_at = unixepoch() WHERE series_id = '39d42804941d0de000bcf1b4faf7b1f1' AND EXISTS (SELECT 1 FROM event_series WHERE id = '5daa79bc3c162209f4347799a8e04a12');
DELETE FROM event_series WHERE id = '39d42804941d0de000bcf1b4faf7b1f1';

-- Terryville Lions Country Fair  (keeper: terryville-lions-country-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '8c4264878e89a6a0a80b5b0fb7733724', 'terryville-lions-country-fair-ct', 'terryville-lions-country-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '8c4264878e89a6a0a80b5b0fb7733724');
UPDATE events SET series_id = '8c4264878e89a6a0a80b5b0fb7733724', updated_at = unixepoch() WHERE series_id = 'd28d6b30c6bb45e2a7bca2057994d389' AND EXISTS (SELECT 1 FROM event_series WHERE id = '8c4264878e89a6a0a80b5b0fb7733724');
DELETE FROM event_series WHERE id = 'd28d6b30c6bb45e2a7bca2057994d389';

-- The Bradford Fair  (keeper: the-bradford-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '07bfdd9693e1ab7ebaedbf89e2314ca6', 'the-bradford-fair-vt', 'the-bradford-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '07bfdd9693e1ab7ebaedbf89e2314ca6');
UPDATE events SET series_id = '07bfdd9693e1ab7ebaedbf89e2314ca6', updated_at = unixepoch() WHERE series_id = 'a6a3e63846ac0b0e8b7dada1cc0921c8' AND EXISTS (SELECT 1 FROM event_series WHERE id = '07bfdd9693e1ab7ebaedbf89e2314ca6');
DELETE FROM event_series WHERE id = 'a6a3e63846ac0b0e8b7dada1cc0921c8';

-- Three County Fair  (keeper: three-county-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3c2fe9c656395d787d6be0b9b718ac12', 'three-county-fair-ma', 'three-county-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3c2fe9c656395d787d6be0b9b718ac12');
UPDATE events SET series_id = '3c2fe9c656395d787d6be0b9b718ac12', updated_at = unixepoch() WHERE series_id = '762a10bdb75e76ae7e0cdefe2638a2cd' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3c2fe9c656395d787d6be0b9b718ac12');
DELETE FROM event_series WHERE id = '762a10bdb75e76ae7e0cdefe2638a2cd';

-- Tolland County 4-H Fair  (keeper: tolland-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '6ea8406f2e21efd840c2c4819f3049a4', 'tolland-county-4-h-fair-ct', 'tolland-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '6ea8406f2e21efd840c2c4819f3049a4');
UPDATE events SET series_id = '6ea8406f2e21efd840c2c4819f3049a4', updated_at = unixepoch() WHERE series_id = '79eed850b79e458c0a1fe93f8f12fe49' AND EXISTS (SELECT 1 FROM event_series WHERE id = '6ea8406f2e21efd840c2c4819f3049a4');
DELETE FROM event_series WHERE id = '79eed850b79e458c0a1fe93f8f12fe49';

-- Topsfield Fair  (keeper: topsfield-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'ebcc278902a226a1c900fe1878d5a849', 'topsfield-fair-ma', 'topsfield-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'ebcc278902a226a1c900fe1878d5a849');
UPDATE events SET series_id = 'ebcc278902a226a1c900fe1878d5a849', updated_at = unixepoch() WHERE series_id = '5c52688f5ea03738e8ee919b91820ef2' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'ebcc278902a226a1c900fe1878d5a849');
DELETE FROM event_series WHERE id = '5c52688f5ea03738e8ee919b91820ef2';

-- Topsham Fair  (keeper: topsham-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3a5f53cd9bc9f38702e4348b4c670ff9', 'topsham-fair-me', 'topsham-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3a5f53cd9bc9f38702e4348b4c670ff9');
UPDATE events SET series_id = '3a5f53cd9bc9f38702e4348b4c670ff9', updated_at = unixepoch() WHERE series_id = '36ed64b322fecfa8b107af4142c30e54' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3a5f53cd9bc9f38702e4348b4c670ff9');
DELETE FROM event_series WHERE id = '36ed64b322fecfa8b107af4142c30e54';

-- Union Fair  (keeper: union-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '851e8d9f424fab266653831279ec092b', 'union-fair-me', 'union-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '851e8d9f424fab266653831279ec092b');
UPDATE events SET series_id = '851e8d9f424fab266653831279ec092b', updated_at = unixepoch() WHERE series_id = '07c41100e6a8abd57581f39797648c77' AND EXISTS (SELECT 1 FROM event_series WHERE id = '851e8d9f424fab266653831279ec092b');
DELETE FROM event_series WHERE id = '07c41100e6a8abd57581f39797648c77';

-- Vacationland RV & Camping Show  (keeper: vacationland-rv-and-camping-show, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '371a0c16c22c15d78e547e55f116bce8', 'vacationland-rv-camping-show', 'vacationland-rv-and-camping-show', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '371a0c16c22c15d78e547e55f116bce8');
UPDATE events SET series_id = '371a0c16c22c15d78e547e55f116bce8', updated_at = unixepoch() WHERE series_id = '528ccc4016e9bfb794aee4ca470878ab' AND EXISTS (SELECT 1 FROM event_series WHERE id = '371a0c16c22c15d78e547e55f116bce8');
DELETE FROM event_series WHERE id = '528ccc4016e9bfb794aee4ca470878ab';

-- Vermont Sheep & Wool Festival  (keeper: vermont-sheep-wool-festival, rule: shortest(suffix-shape))
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'e74553c1ed45f20567a889b5ee42f024', 'vermont-sheep-wool-festival-2026-2', 'vermont-sheep-wool-festival', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'e74553c1ed45f20567a889b5ee42f024');
UPDATE events SET series_id = 'e74553c1ed45f20567a889b5ee42f024', updated_at = unixepoch() WHERE series_id = 'f93a2e7f9fff5d6e70376d65792ba624' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'e74553c1ed45f20567a889b5ee42f024');
DELETE FROM event_series WHERE id = 'f93a2e7f9fff5d6e70376d65792ba624';

-- Vermont State Fair  (keeper: vermont-state-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '72a845a103fa8a9e1f8b869072afcdfb', 'vermont-state-fair-vt', 'vermont-state-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '72a845a103fa8a9e1f8b869072afcdfb');
UPDATE events SET series_id = '72a845a103fa8a9e1f8b869072afcdfb', updated_at = unixepoch() WHERE series_id = '488905ebb8e4946d49e95aeef4e3b748' AND EXISTS (SELECT 1 FROM event_series WHERE id = '72a845a103fa8a9e1f8b869072afcdfb');
DELETE FROM event_series WHERE id = '488905ebb8e4946d49e95aeef4e3b748';

-- Wallingford Grange Fair  (keeper: wallingford-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '25cc704b827385c65b2cfaebd5eef25f', 'wallingford-grange-fair-ct', 'wallingford-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '25cc704b827385c65b2cfaebd5eef25f');
UPDATE events SET series_id = '25cc704b827385c65b2cfaebd5eef25f', updated_at = unixepoch() WHERE series_id = 'fd696cb236471cee47167a2e3d3181b4' AND EXISTS (SELECT 1 FROM event_series WHERE id = '25cc704b827385c65b2cfaebd5eef25f');
DELETE FROM event_series WHERE id = 'fd696cb236471cee47167a2e3d3181b4';

-- Wapping Fair  (keeper: wapping-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4a5ff8968e0b28bbffc867bd77d4bbd6', 'wapping-fair-ct', 'wapping-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4a5ff8968e0b28bbffc867bd77d4bbd6');
UPDATE events SET series_id = '4a5ff8968e0b28bbffc867bd77d4bbd6', updated_at = unixepoch() WHERE series_id = '7868069ca4febfe1fff5006f30c56589' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4a5ff8968e0b28bbffc867bd77d4bbd6');
DELETE FROM event_series WHERE id = '7868069ca4febfe1fff5006f30c56589';

-- Ware Grange Fair  (keeper: ware-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'e2fd5c4002b3584be506f7569506bd91', 'ware-grange-fair-ma', 'ware-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'e2fd5c4002b3584be506f7569506bd91');
UPDATE events SET series_id = 'e2fd5c4002b3584be506f7569506bd91', updated_at = unixepoch() WHERE series_id = '91bbfeab895d180fd4af6a6bf09c889d' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'e2fd5c4002b3584be506f7569506bd91');
DELETE FROM event_series WHERE id = '91bbfeab895d180fd4af6a6bf09c889d';

-- Waterford World's Fair  (keeper: waterford-worlds-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '91606a7bf3818e6b32c5117bb1548a40', 'waterford-world-s-fair', 'waterford-worlds-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '91606a7bf3818e6b32c5117bb1548a40');
UPDATE events SET series_id = '91606a7bf3818e6b32c5117bb1548a40', updated_at = unixepoch() WHERE series_id = '3702906f1b115f955a6e62a28a504df9' AND EXISTS (SELECT 1 FROM event_series WHERE id = '91606a7bf3818e6b32c5117bb1548a40');
DELETE FROM event_series WHERE id = '3702906f1b115f955a6e62a28a504df9';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '91606a7bf3818e6b32c5117bb1548a40', 'waterford-worlds-fair-me', 'waterford-worlds-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '91606a7bf3818e6b32c5117bb1548a40');
UPDATE events SET series_id = '91606a7bf3818e6b32c5117bb1548a40', updated_at = unixepoch() WHERE series_id = 'c8651155768046a35bf9398f9f8a4e5f' AND EXISTS (SELECT 1 FROM event_series WHERE id = '91606a7bf3818e6b32c5117bb1548a40');
DELETE FROM event_series WHERE id = 'c8651155768046a35bf9398f9f8a4e5f';

-- Westport Fair  (keeper: westport-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '49c80381e9026300259a1d2e0324b2b7', 'westport-fair-ma', 'westport-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '49c80381e9026300259a1d2e0324b2b7');
UPDATE events SET series_id = '49c80381e9026300259a1d2e0324b2b7', updated_at = unixepoch() WHERE series_id = 'de3b59d5bfaa573cb14c0cc7d1577b6b' AND EXISTS (SELECT 1 FROM event_series WHERE id = '49c80381e9026300259a1d2e0324b2b7');
DELETE FROM event_series WHERE id = 'de3b59d5bfaa573cb14c0cc7d1577b6b';

-- Williamsburg Grange Fair  (keeper: williamsburg-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '4242efb52495ed9cbc8c5a7fc5c86589', 'williamsburg-grange-fair-ma', 'williamsburg-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '4242efb52495ed9cbc8c5a7fc5c86589');
UPDATE events SET series_id = '4242efb52495ed9cbc8c5a7fc5c86589', updated_at = unixepoch() WHERE series_id = '958c0893ddc2b9b4d13dec0513673009' AND EXISTS (SELECT 1 FROM event_series WHERE id = '4242efb52495ed9cbc8c5a7fc5c86589');
DELETE FROM event_series WHERE id = '958c0893ddc2b9b4d13dec0513673009';

-- Winchester Grange Fair  (keeper: winchester-grange-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '6f92708fb093db50ec2dc45f975d5049', 'winchester-grange-fair-ct', 'winchester-grange-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '6f92708fb093db50ec2dc45f975d5049');
UPDATE events SET series_id = '6f92708fb093db50ec2dc45f975d5049', updated_at = unixepoch() WHERE series_id = 'f380ee2e9e90163078dda13bbd9442c1' AND EXISTS (SELECT 1 FROM event_series WHERE id = '6f92708fb093db50ec2dc45f975d5049');
DELETE FROM event_series WHERE id = 'f380ee2e9e90163078dda13bbd9442c1';

-- Windham County 4-H Fair  (keeper: windham-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a0c2d9f8dc68077f3b784fd1e510dd2a', 'windham-county-4-h-fair-ct', 'windham-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a0c2d9f8dc68077f3b784fd1e510dd2a');
UPDATE events SET series_id = 'a0c2d9f8dc68077f3b784fd1e510dd2a', updated_at = unixepoch() WHERE series_id = '410eec793b6603142fdf1fededb33818' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a0c2d9f8dc68077f3b784fd1e510dd2a');
DELETE FROM event_series WHERE id = '410eec793b6603142fdf1fededb33818';

-- Windsor Fair  (keeper: windsor-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'ffc462dd43c15fb788a7ef01aa12e4d9', 'windsor-fair-me', 'windsor-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'ffc462dd43c15fb788a7ef01aa12e4d9');
UPDATE events SET series_id = 'ffc462dd43c15fb788a7ef01aa12e4d9', updated_at = unixepoch() WHERE series_id = 'e03a12324409a1bdd4b303ce3c1af31b' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'ffc462dd43c15fb788a7ef01aa12e4d9');
DELETE FROM event_series WHERE id = 'e03a12324409a1bdd4b303ce3c1af31b';

-- Winslow VFW Crafts Fair  (keeper: winslow-vfw-crafts-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '62689df5ed20e08c32c31116d058bd23', 'winslow-vfw-crafts-fair-2026-duplicate', 'winslow-vfw-crafts-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '62689df5ed20e08c32c31116d058bd23');
UPDATE events SET series_id = '62689df5ed20e08c32c31116d058bd23', updated_at = unixepoch() WHERE series_id = '3a374125cc08f1ba471e0dd8714b5964' AND EXISTS (SELECT 1 FROM event_series WHERE id = '62689df5ed20e08c32c31116d058bd23');
DELETE FROM event_series WHERE id = '3a374125cc08f1ba471e0dd8714b5964';

-- Worcester County 4-H Fair  (keeper: worcester-county-4-h-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'c713ac9f3cabc86de356c55cc90a23e9', 'worcester-county-4-h-fair-ma', 'worcester-county-4-h-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'c713ac9f3cabc86de356c55cc90a23e9');
UPDATE events SET series_id = 'c713ac9f3cabc86de356c55cc90a23e9', updated_at = unixepoch() WHERE series_id = 'f85d8a11b543656edb166346326a3cd3' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'c713ac9f3cabc86de356c55cc90a23e9');
DELETE FROM event_series WHERE id = 'f85d8a11b543656edb166346326a3cd3';

-- Harwinton Fair  (keeper: harwinton-fair, rule: canonical)
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'adf5b006a16d1fcfa646715bc55f11df', 'harwinton-fair-ct', 'harwinton-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'adf5b006a16d1fcfa646715bc55f11df');
UPDATE events SET series_id = 'adf5b006a16d1fcfa646715bc55f11df', updated_at = unixepoch() WHERE series_id = '27c9f7f0e35d40159c526a5f8769a990' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'adf5b006a16d1fcfa646715bc55f11df');
DELETE FROM event_series WHERE id = '27c9f7f0e35d40159c526a5f8769a990';
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'adf5b006a16d1fcfa646715bc55f11df', 'harwinton-fair-2026-1', 'harwinton-fair', unixepoch(), 'ope-473' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'adf5b006a16d1fcfa646715bc55f11df');
UPDATE events SET series_id = 'adf5b006a16d1fcfa646715bc55f11df', updated_at = unixepoch() WHERE series_id = '025eef0dacd9af1fc35285f95535bbdd' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'adf5b006a16d1fcfa646715bc55f11df');
DELETE FROM event_series WHERE id = '025eef0dacd9af1fc35285f95535bbdd';

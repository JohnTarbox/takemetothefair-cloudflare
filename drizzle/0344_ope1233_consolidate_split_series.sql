-- OPE-1233 + OPE-1187 — consolidate 13 fairs split across two event_series.
--
-- John's rulings (2026-09-30): OPE-825 → OPE-1233 "route the 12 split fair
-- series ... for a generator fix plus redirects. Proceed."; OPE-1186 → OPE-1187
-- "consolidate the Big E into ONE evergreen series", survivor slug
-- `the-big-e-eastern-states-exposition`.
--
-- Same procedure as OPE-473 (drizzle/0211), per docs/bulk-mutation-discipline.md:
--   history row → re-parent → delete, in that order, per pair. events.series_id
--   is ON DELETE SET NULL, so deleting a parent first would orphan its child.
--   Every write is guarded on the keeper existing, so on an EMPTY database (CI)
--   each statement is a no-op rather than an FK abort.
-- No event slug changes. Redirects come from series_slug_history, which the
-- middleware already walks for both /events/<slug> and /events/<slug>/<year>.
-- Rollback: docs/ope1233/rollback.sql (+ the two pre-change dumps beside it).

-- barnstable-county-fair-ma → barnstable-county-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a9fac612eaf6297e7b3f4932d785da86', 'barnstable-county-fair-ma', 'barnstable-county-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a9fac612eaf6297e7b3f4932d785da86');
UPDATE events SET series_id = 'a9fac612eaf6297e7b3f4932d785da86', updated_at = unixepoch() WHERE series_id = 'b494eab2ef15c2346f981870cf5586b1' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a9fac612eaf6297e7b3f4932d785da86');
DELETE FROM event_series WHERE id = 'b494eab2ef15c2346f981870cf5586b1' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a9fac612eaf6297e7b3f4932d785da86');

-- belchertown-fair-ma → belchertown-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '27592c963ab0b51597f3974577f7df93', 'belchertown-fair-ma', 'belchertown-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '27592c963ab0b51597f3974577f7df93');
UPDATE events SET series_id = '27592c963ab0b51597f3974577f7df93', updated_at = unixepoch() WHERE series_id = '61f62aeb84099cf81fd29bdbbb538766' AND EXISTS (SELECT 1 FROM event_series WHERE id = '27592c963ab0b51597f3974577f7df93');
DELETE FROM event_series WHERE id = '61f62aeb84099cf81fd29bdbbb538766' AND EXISTS (SELECT 1 FROM event_series WHERE id = '27592c963ab0b51597f3974577f7df93');

-- berlin-fair-ct → berlin-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '655c351bb37443cbff365d150721555f', 'berlin-fair-ct', 'berlin-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '655c351bb37443cbff365d150721555f');
UPDATE events SET series_id = '655c351bb37443cbff365d150721555f', updated_at = unixepoch() WHERE series_id = 'd037dcca2bba4b2d8b1b925a8ca27107' AND EXISTS (SELECT 1 FROM event_series WHERE id = '655c351bb37443cbff365d150721555f');
DELETE FROM event_series WHERE id = 'd037dcca2bba4b2d8b1b925a8ca27107' AND EXISTS (SELECT 1 FROM event_series WHERE id = '655c351bb37443cbff365d150721555f');

-- bolton-fair-ma → bolton-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '758f793bb92743e64b7547b196476a06', 'bolton-fair-ma', 'bolton-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '758f793bb92743e64b7547b196476a06');
UPDATE events SET series_id = '758f793bb92743e64b7547b196476a06', updated_at = unixepoch() WHERE series_id = '4c88ad7f5d3ee0d9288092322c6c08c4' AND EXISTS (SELECT 1 FROM event_series WHERE id = '758f793bb92743e64b7547b196476a06');
DELETE FROM event_series WHERE id = '4c88ad7f5d3ee0d9288092322c6c08c4' AND EXISTS (SELECT 1 FROM event_series WHERE id = '758f793bb92743e64b7547b196476a06');

-- cummington-fair-ma → cummington-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '3296e9e297c8002f0064dd7671b47189', 'cummington-fair-ma', 'cummington-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '3296e9e297c8002f0064dd7671b47189');
UPDATE events SET series_id = '3296e9e297c8002f0064dd7671b47189', updated_at = unixepoch() WHERE series_id = 'f565175e13121c267f3e1ceb81187769' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3296e9e297c8002f0064dd7671b47189');
DELETE FROM event_series WHERE id = 'f565175e13121c267f3e1ceb81187769' AND EXISTS (SELECT 1 FROM event_series WHERE id = '3296e9e297c8002f0064dd7671b47189');

-- haddam-neck-fair-ct → haddam-neck-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'c56d852099c004bcecec7f8aa0df286b', 'haddam-neck-fair-ct', 'haddam-neck-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'c56d852099c004bcecec7f8aa0df286b');
UPDATE events SET series_id = 'c56d852099c004bcecec7f8aa0df286b', updated_at = unixepoch() WHERE series_id = '8245349249691df00264699bfeded13b' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'c56d852099c004bcecec7f8aa0df286b');
DELETE FROM event_series WHERE id = '8245349249691df00264699bfeded13b' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'c56d852099c004bcecec7f8aa0df286b');

-- marshfield-fair-ma → marshfield-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'aeb7c11bfe885e05268997557426ede2', 'marshfield-fair-ma', 'marshfield-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'aeb7c11bfe885e05268997557426ede2');
UPDATE events SET series_id = 'aeb7c11bfe885e05268997557426ede2', updated_at = unixepoch() WHERE series_id = '6291a61d6ba2d6fe74c455fe42502ef3' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'aeb7c11bfe885e05268997557426ede2');
DELETE FROM event_series WHERE id = '6291a61d6ba2d6fe74c455fe42502ef3' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'aeb7c11bfe885e05268997557426ede2');

-- sterling-fair-ma → sterling-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '800faac7ffcab16d40ae37858d936b82', 'sterling-fair-ma', 'sterling-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '800faac7ffcab16d40ae37858d936b82');
UPDATE events SET series_id = '800faac7ffcab16d40ae37858d936b82', updated_at = unixepoch() WHERE series_id = 'd9c88d9fd9778e8fb1d398bc64083528' AND EXISTS (SELECT 1 FROM event_series WHERE id = '800faac7ffcab16d40ae37858d936b82');
DELETE FROM event_series WHERE id = 'd9c88d9fd9778e8fb1d398bc64083528' AND EXISTS (SELECT 1 FROM event_series WHERE id = '800faac7ffcab16d40ae37858d936b82');

-- tunbridge-worlds-fair-vt → tunbridge-worlds-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a0ccc956afe91a7efef85d6f4bd4049e', 'tunbridge-worlds-fair-vt', 'tunbridge-worlds-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a0ccc956afe91a7efef85d6f4bd4049e');
UPDATE events SET series_id = 'a0ccc956afe91a7efef85d6f4bd4049e', updated_at = unixepoch() WHERE series_id = '5baca53e750954425814280bcecf712e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a0ccc956afe91a7efef85d6f4bd4049e');
DELETE FROM event_series WHERE id = '5baca53e750954425814280bcecf712e' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a0ccc956afe91a7efef85d6f4bd4049e');

-- westfield-fair-ma → westfield-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), 'a49df3f41736570d9aeda98c11cef441', 'westfield-fair-ma', 'westfield-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = 'a49df3f41736570d9aeda98c11cef441');
UPDATE events SET series_id = 'a49df3f41736570d9aeda98c11cef441', updated_at = unixepoch() WHERE series_id = '95146e16b63fab1771440e3f344c833d' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a49df3f41736570d9aeda98c11cef441');
DELETE FROM event_series WHERE id = '95146e16b63fab1771440e3f344c833d' AND EXISTS (SELECT 1 FROM event_series WHERE id = 'a49df3f41736570d9aeda98c11cef441');

-- wolcott-country-fair-ct → wolcott-country-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '003671f58257b24fd20280edd090a795', 'wolcott-country-fair-ct', 'wolcott-country-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '003671f58257b24fd20280edd090a795');
UPDATE events SET series_id = '003671f58257b24fd20280edd090a795', updated_at = unixepoch() WHERE series_id = '0b109932bd58434bb450cea5bffcf536' AND EXISTS (SELECT 1 FROM event_series WHERE id = '003671f58257b24fd20280edd090a795');
DELETE FROM event_series WHERE id = '0b109932bd58434bb450cea5bffcf536' AND EXISTS (SELECT 1 FROM event_series WHERE id = '003671f58257b24fd20280edd090a795');

-- woodstock-fair-ct → woodstock-fair
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '32d4a2014a5bfc432748a5f26eb4a397', 'woodstock-fair-ct', 'woodstock-fair', unixepoch(), 'ope-1233' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '32d4a2014a5bfc432748a5f26eb4a397');
UPDATE events SET series_id = '32d4a2014a5bfc432748a5f26eb4a397', updated_at = unixepoch() WHERE series_id = 'b84af3ad714af7a8cec5e9626b3d9e9f' AND EXISTS (SELECT 1 FROM event_series WHERE id = '32d4a2014a5bfc432748a5f26eb4a397');
DELETE FROM event_series WHERE id = 'b84af3ad714af7a8cec5e9626b3d9e9f' AND EXISTS (SELECT 1 FROM event_series WHERE id = '32d4a2014a5bfc432748a5f26eb4a397');

-- The Big E (OPE-1187). Keeper = the evergreen-named series (415479ad80a361d18839c69ee5d998dd),
-- renamed to the approved survivor slug; the year-in-slug series is retired.
-- Rename only when the survivor slug is free (canonical_slug is UNIQUE).
UPDATE event_series SET canonical_slug = 'the-big-e-eastern-states-exposition', updated_at = unixepoch() WHERE id = '415479ad80a361d18839c69ee5d998dd' AND NOT EXISTS (SELECT 1 FROM event_series WHERE canonical_slug = 'the-big-e-eastern-states-exposition');
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '415479ad80a361d18839c69ee5d998dd', 'the-big-e-eastern-states-exposition-ma', 'the-big-e-eastern-states-exposition', unixepoch(), 'ope-1187' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '415479ad80a361d18839c69ee5d998dd' AND canonical_slug = 'the-big-e-eastern-states-exposition');
INSERT OR IGNORE INTO series_slug_history (id, series_id, old_slug, new_slug, changed_at, changed_by) SELECT lower(hex(randomblob(16))), '415479ad80a361d18839c69ee5d998dd', 'the-big-e-2026-eastern-states-exposition', 'the-big-e-eastern-states-exposition', unixepoch(), 'ope-1187' WHERE EXISTS (SELECT 1 FROM event_series WHERE id = '415479ad80a361d18839c69ee5d998dd' AND canonical_slug = 'the-big-e-eastern-states-exposition');
UPDATE events SET series_id = '415479ad80a361d18839c69ee5d998dd', updated_at = unixepoch() WHERE series_id = '093a7e65db7e106b000968d57759aaac' AND EXISTS (SELECT 1 FROM event_series WHERE id = '415479ad80a361d18839c69ee5d998dd' AND canonical_slug = 'the-big-e-eastern-states-exposition');
DELETE FROM event_series WHERE id = '093a7e65db7e106b000968d57759aaac' AND EXISTS (SELECT 1 FROM event_series WHERE id = '415479ad80a361d18839c69ee5d998dd' AND canonical_slug = 'the-big-e-eastern-states-exposition');

-- OPE-1187 — the surviving series' evergreen description must not carry one
-- edition's dates ("returns September 18 through October 4, 2026"). Rewritten
-- in place: only that opening clause changes, and no projected 2027 date is
-- asserted (the 2027 edition is TENTATIVE).
UPDATE event_series SET description = replace(description, 'The Big E (Eastern States Exposition) returns September 18 through October 4, 2026 in West Springfield, Massachusetts — New England''s largest', 'The Big E (Eastern States Exposition) is held each September and early October in West Springfield, Massachusetts — New England''s largest'), updated_at = unixepoch() WHERE id = '415479ad80a361d18839c69ee5d998dd' AND instr(description, 'October 4, 2026') > 0;

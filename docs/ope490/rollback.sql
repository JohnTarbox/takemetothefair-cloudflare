-- OPE-490 COMPENSATING SQL. Ships with the forward migration per OPE-53.
-- Restores the pre-change state exactly: re-insert the two retired parents,
-- re-point both events at their ORIGINAL series, restore the Maine Pottery Tour
-- keeper's original content fields, drop the two redirect rows.
--
-- Order mirrors the forward run in reverse: parents must exist BEFORE the events
-- point back at them, or `events.series_id`'s ON DELETE SET NULL leaves them
-- orphaned. Every statement is independently re-runnable.
--
-- Sourced from docs/ope490/pre-change-series-dump.json (all four rows, every
-- column) and docs/ope490/pre-change-event-series-map.json.

-- 1. re-insert the 2 retired parents, every column verbatim
INSERT OR IGNORE INTO event_series
  (id, canonical_slug, name, venue_id, promoter_id, recurrence_rule, description, image_url, categories, tags, primary_audience, public_access, created_at, updated_at)
VALUES
  ('3108923d4c7d956a3aa4c5f2e82f873d','maine-pottery-tour-2026-1','Maine Pottery Tour',NULL,'system-community-suggestions',NULL,
   'Annual self-guided tour of Maine pottery studios, with potters across the state opening their doors to visitors for demonstrations, sales, and studio tours.',
   'https://cdn.meetmeatthefair.com/events/e62cc863-ce9b-4004-8039-04e208b0ef4e/image-1778118368561.jpg',
   '["Festival"]','["pottery","artisan","statewide","studio-tour","spring"]','PUBLIC','OPEN',1782133213,1784127161);

INSERT OR IGNORE INTO event_series
  (id, canonical_slug, name, venue_id, promoter_id, recurrence_rule, description, image_url, categories, tags, primary_audience, public_access, created_at, updated_at)
VALUES
  ('6884cba94c324736cecaedd4a3f9d958','fiber-festival-of-new-england-2026-1','Fiber Festival of New England',NULL,'b4401fb2-8bb7-4764-80be-5625434f8cdc',NULL,
   'The Fiber Festival of New England returns to the Mallary Complex at the Eastern States Exposition in West Springfield, MA. The festival features more than 200 booths and 22 workshops for fiber enthusiasts, with sheep shearing, a fleece sale, fiber animals, spinning and weaving demonstrations, finished items for sale, and a fiber fashion show. Admission is $9 for ages 13 and up; children under 12 are free, and tickets are also sold at the door.',
   NULL,'["Fiber Arts Festival","Craft Fair","Festival"]','["community-suggestion","vendor-submission"]','PUBLIC','OPEN',1782133213,1784127161);

-- 2. re-point both events at their ORIGINAL parents (guarded on the parent
--    existing, so a partial rollback never nulls a series_id)
UPDATE events SET series_id = '3108923d4c7d956a3aa4c5f2e82f873d'
WHERE id = 'e62cc863-ce9b-4004-8039-04e208b0ef4e'
  AND EXISTS (SELECT 1 FROM event_series WHERE id = '3108923d4c7d956a3aa4c5f2e82f873d');

UPDATE events SET series_id = '6884cba94c324736cecaedd4a3f9d958'
WHERE id = 'b4248709-c30b-48a1-b98c-f2fc2638af3c'
  AND EXISTS (SELECT 1 FROM event_series WHERE id = '6884cba94c324736cecaedd4a3f9d958');

-- 3. restore the Maine Pottery Tour keeper's ORIGINAL content (the duplicate
--    marker the forward run replaced). Only group 1 carried content; the Fiber
--    keeper was never touched, so there is nothing to restore for it.
UPDATE event_series SET
  description = '[DUPLICATE — superseded by event e62cc863-ce9b-4004-8039-04e208b0ef4e (slug: maine-pottery-tour-2026-1). Merged on 2026-04-21: ticket_url + image_url copied to canonical record. Newer record has full vendor list (85 confirmed), richer schedule, and is attached to Statewide (ME) venue.]',
  image_url   = 'https://www.mainemade.com/wp-content/uploads/2026/01/Maine-Pottery-Tour-2026.jpg',
  categories  = '["Community Event"]',
  tags        = '["duplicate","merged-2026-04-21"]',
  updated_at  = 1784127161
WHERE id = '0e1e7676767e411db8f13de2c373f53d';

-- 4. drop the redirect rows this run wrote (scoped by changed_by so an unrelated
--    rename of the same slug is never collateral)
DELETE FROM series_slug_history
WHERE changed_by = 'ope-490'
  AND old_slug IN ('maine-pottery-tour-2026-1','fiber-festival-of-new-england-2026-1');

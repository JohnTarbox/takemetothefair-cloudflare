-- OPE-1373 — backfill venue_slug_history for 14 venues whose old slug was live
-- (queued in pending_search_pings, May 2026) but has no history row, so
-- /venues/<old> 404s instead of 301ing to the current slug.
--
-- One single-row INSERT per venue: D1 rejects a 14-term UNION ALL ("too many
-- terms in compound SELECT"), which local sqlite accepts — measured 2026-10-16.
-- Each row is guarded: the venue exists with the target as its live slug, no
-- live venue owns the old slug, and no history row for the old slug exists.
-- Idempotent and a no-op on an empty db. Rollback:
--   DELETE FROM venue_slug_history WHERE changed_by = 'backfill:OPE-1373';

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '1d10512f-841e-4826-b316-45d8f4d5d7eb', '331-high-st', 'newburyport-community-center', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '1d10512f-841e-4826-b316-45d8f4d5d7eb' AND v.slug = 'newburyport-community-center')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = '331-high-st')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = '331-high-st');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '28b78459-8193-44ba-8828-838f68d9f5fa', '76-us-route-1', 'machias-valley-market-grounds', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '28b78459-8193-44ba-8828-838f68d9f5fa' AND v.slug = 'machias-valley-market-grounds')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = '76-us-route-1')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = '76-us-route-1');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '2add6e80-2ff0-47f6-aea4-0e2f67d93d32', 'hillsborough-county-agricultural-fair', 'hillsborough-county-4-h-fairgrounds', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '2add6e80-2ff0-47f6-aea4-0e2f67d93d32' AND v.slug = 'hillsborough-county-4-h-fairgrounds')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'hillsborough-county-agricultural-fair')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'hillsborough-county-agricultural-fair');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '33897ff7-57a2-42a2-8f03-93bec0e66cdf', 'farmington-fair', 'farmington-fairgrounds', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '33897ff7-57a2-42a2-8f03-93bec0e66cdf' AND v.slug = 'farmington-fairgrounds')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'farmington-fair')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'farmington-fair');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '50e5ae95-ff8c-4b81-9884-c0092da2b268', 'head-of-falls-60-front-street', 'head-of-falls-park-1', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '50e5ae95-ff8c-4b81-9884-c0092da2b268' AND v.slug = 'head-of-falls-park-1')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'head-of-falls-60-front-street')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'head-of-falls-60-front-street');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '62d96072-4cbb-4f5d-8f91-cc362321da14', 'deerfield-fair-1', 'deerfield-fairgrounds', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '62d96072-4cbb-4f5d-8f91-cc362321da14' AND v.slug = 'deerfield-fairgrounds')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'deerfield-fair-1')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'deerfield-fair-1');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '6e7ffdb8-ce70-411c-880a-350f5e750109', '345-pine-street-burlington-south-end', 'burlington-pine-street-market-grounds', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '6e7ffdb8-ce70-411c-880a-350f5e750109' AND v.slug = 'burlington-pine-street-market-grounds')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = '345-pine-street-burlington-south-end')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = '345-pine-street-burlington-south-end');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '74e6eadb-2f2a-4948-920e-6a9dfc1e95c1', 'franklin-county-field-days', 'franklin-county-field-days-grounds-hubbard-lane', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '74e6eadb-2f2a-4948-920e-6a9dfc1e95c1' AND v.slug = 'franklin-county-field-days-grounds-hubbard-lane')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'franklin-county-field-days')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'franklin-county-field-days');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '86512080-f256-4c99-8295-19117c2ff2ce', 'quechee-green-park', 'quechee-village-green', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '86512080-f256-4c99-8295-19117c2ff2ce' AND v.slug = 'quechee-village-green')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'quechee-green-park')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'quechee-green-park');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), 'a772df65-7862-41a5-8913-be8bdbae3411', 'veterans-of-foreign-wars', 'winslow-vfw-post-8835', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = 'a772df65-7862-41a5-8913-be8bdbae3411' AND v.slug = 'winslow-vfw-post-8835')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'veterans-of-foreign-wars')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'veterans-of-foreign-wars');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), 'bb81eec9-2da4-4055-9eb9-33d421f97cc8', 'lords-meeting-house', 'lords-hill-meeting-house', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = 'bb81eec9-2da4-4055-9eb9-33d421f97cc8' AND v.slug = 'lords-hill-meeting-house')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'lords-meeting-house')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'lords-meeting-house');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), 'dcb9d42f-b9c7-4eca-ac12-25487c10ddad', '18-spring-street', 'united-farmers-market-of-maine', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = 'dcb9d42f-b9c7-4eca-ac12-25487c10ddad' AND v.slug = 'united-farmers-market-of-maine')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = '18-spring-street')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = '18-spring-street');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), 'f8bda45f-dfda-4590-bec7-b7bf31cc48ef', 'anah-shriners-hall', 'bektash-shriner-auditorium-concord-nh', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = 'f8bda45f-dfda-4590-bec7-b7bf31cc48ef' AND v.slug = 'bektash-shriner-auditorium-concord-nh')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'anah-shriners-hall')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'anah-shriners-hall');

INSERT INTO venue_slug_history (id, venue_id, old_slug, new_slug, changed_at, changed_by)
SELECT lower(hex(randomblob(16))), '98edc9e5-7630-4ecd-a9ff-134b9adc1e62', 'stratham-4-h-summerfest', 'stratham-hill-park', unixepoch(), 'backfill:OPE-1373'
WHERE EXISTS (SELECT 1 FROM venues v WHERE v.id = '98edc9e5-7630-4ecd-a9ff-134b9adc1e62' AND v.slug = 'stratham-hill-park')
  AND NOT EXISTS (SELECT 1 FROM venues o WHERE o.slug = 'stratham-4-h-summerfest')
  AND NOT EXISTS (SELECT 1 FROM venue_slug_history h WHERE h.old_slug = 'stratham-4-h-summerfest');

-- OPE-1232 rollback for drizzle/0345. Before-state read from prod D1 on
-- 2026-10-01 (planned set = 10 rows, every new venue resolved and ACTIVE).
-- series_id | canonical_slug | venue_id BEFORE -> AFTER
--   67c5f163… bar-harbor-eden-farmers-market          02a3e45e… -> 3b405528… (the-mount-desert-island-ymca)
--   f79dc0f7… augusta-farmers-market-winter-2026      38792939… -> 30fd29ea… (buker-community-center)
--   8ad3d471… vermont-flower-show                     5b614cec… -> 159edfcb… (champlain-valley-exposition)
--   a0ccc956… tunbridge-worlds-fair                   65be445f… -> 7b9e51c8… (tunbridge-fairgrounds)
--   5baca53e… tunbridge-worlds-fair-vt                65be445f… -> 7b9e51c8…
--   1a338d7d… vermont-sheep-wool-festival-2026        65be445f… -> 7b9e51c8…
--   6352e4a6… maine-boat-home-show                    a09ce600… -> f82d2e96… (harbor-park)
--   6d167b6f… champlain-valley-fair                   bdc5d9c7… -> 159edfcb…
--   732d1f6e… new-england-home-show-marlboro          d9aab024… -> d0f1b8b1… (best-western-royal-plaza-trade-center)
--   43eb2a1b… its-finally-fall-makers-market-festival de576e5d… -> 33897ff7… (farmington-fairgrounds)
UPDATE event_series SET venue_id = '02a3e45e-56af-4f7d-a844-d73b73d21ba1' WHERE id = '67c5f163241e5cd4fe7f71226608479b';
UPDATE event_series SET venue_id = '38792939-d31c-4a32-a878-e380fd632b95' WHERE id = 'f79dc0f788a3cb7a56129cd4b8702fd4';
UPDATE event_series SET venue_id = '5b614cec-1a47-4575-a59f-2ac514d7dc3f' WHERE id = '8ad3d471d9410596404a6453d73be515';
UPDATE event_series SET venue_id = '65be445f-8e90-4d8b-b448-19b8c921c5dc' WHERE id IN ('a0ccc956afe91a7efef85d6f4bd4049e','5baca53e750954425814280bcecf712e','1a338d7d936d1da906bb7002c27d0620');
UPDATE event_series SET venue_id = 'a09ce600-1e45-417f-baa8-67266062fe42' WHERE id = '6352e4a6db8019bcaec0f21fde5da570';
UPDATE event_series SET venue_id = 'bdc5d9c7-7f54-4367-a3da-7e3b0ad27aa0' WHERE id = '6d167b6f422c5d6c5246f141134d952d';
UPDATE event_series SET venue_id = 'd9aab024-88b2-44ee-ae96-2d9bd304e673' WHERE id = '732d1f6efa20a6008e51b171ad81932b';
UPDATE event_series SET venue_id = 'de576e5d-2452-433d-987c-d619cb5fb80d' WHERE id = '43eb2a1bc435e457cb9a5aca17861c2d';

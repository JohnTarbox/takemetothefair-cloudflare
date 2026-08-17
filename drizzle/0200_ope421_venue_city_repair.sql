-- OPE-421 — venue/fairground names written into `venues.city`.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned. And it follows that doc's warning
-- (and OPE-219's) NOT to bulk-rewrite on a heuristic: this repairs three named
-- rows, each verified individually, rather than everything a pattern matched.
--
-- ---------------------------------------------------------------------------
-- Why the obvious heuristic had to be thrown away
-- ---------------------------------------------------------------------------
--
-- A keyword sweep for city values containing Fairgrounds / Grounds / Center /
-- Park / Museum / Hall / a trailing state code returned 9 rows across 968
-- active venues. SIX of those nine were correct data:
--
--   Winchester Center, CT    a real village   (and already in the CT region list)
--   Cumberland Center, ME    a real village
--   Manchester Center, VT    a real village   (x2 rows)
--   Hallowell, ME            matched only because it contains "hall"
--   Winhall, VT              matched only because it contains "hall"
--
-- A confident automated fix would have rewritten six correct rows — the exact
-- failure that produced OPE-219's four wrong pins. 67% false-positive rate on a
-- rule that looked reasonable when written.
--
-- ---------------------------------------------------------------------------
-- The three that are genuinely wrong
-- ---------------------------------------------------------------------------
--
-- In all three the city column holds the FAIRGROUND's name. No New England
-- municipality contains "Fairgrounds" or "Grounds", which is what makes these
-- separable from the villages above.
--
--   7270a91c  Hampshire County 4-H Fair   "Cummington Fairgrounds"       -> Cummington
--   3545e9f7  Bolton Fair                 "Fairgrounds at Lancaster"     -> Lancaster
--   56e66e39  Hampden County 4-H Fair     "West Springfield Big-E Grounds" -> West Springfield
--
-- Each target town is corroborated three ways: it is the town named inside the
-- bad value itself, it matches the row's stored coordinates, and it is already
-- present in the OPE-395 region town lists — so each of these six live events
-- starts appearing on its region page the moment this lands. No guessing.
--
-- ---------------------------------------------------------------------------
-- Deliberately NOT changed
-- ---------------------------------------------------------------------------
--
-- `Littleville, MA` is a real village inside Chester and its stored value is
-- correct; it misses the region facet only because the town list holds
-- municipalities. Rewriting it to "Chester" would corrupt correct data to
-- satisfy a lookup. The town list is the thing that was incomplete, so
-- `littleville` is added there instead (facet-regions.ts) — a one-line edit
-- next to `chester`, in the same region. Villages are OPE-425's alias problem,
-- not a data defect.
--
-- `West Tisbury MV` from the ticket is already repaired in production.
--
-- ---------------------------------------------------------------------------
-- Idempotency, rollback, and one thing to know afterwards
-- ---------------------------------------------------------------------------
--
-- Each statement is keyed on BOTH the id and the exact bad value, so a re-run
-- matches nothing and a row someone has since edited by hand is left alone
-- rather than clobbered. Rollback is the inverse UPDATE; the prior values are
-- recorded above.
--
-- `updated_at` is bumped: `venues.city` is rendered publicly, so this is a real
-- content change and the sitemap/validator should see it (unlike the flag-only
-- half of OPE-435, which deliberately did not bump).
--
-- NOTE for whoever picks up venue dedup: fixing 7270a91c reveals that it and
-- `733dbdc7` ("Cummington Fairgrounds", city already Cummington) share
-- IDENTICAL coordinates (42.441, -72.9156) — two venue rows for one fairground.
-- `3545e9f7` and `d449a66e` ("The Fairgrounds at Lancaster") are ~1km apart and
-- look like the same place too. Merging venues is a separate decision with its
-- own slug-history consequences, so this migration does not attempt it.

-- Keyed on the exact bad value + state rather than on an id: the ids above are
-- abbreviated to 8 chars for readability, and writing a guessed full UUID into
-- a migration is how you silently update the wrong row (or none at all).
UPDATE venues
SET city = 'Cummington', updated_at = unixepoch()
WHERE city = 'Cummington Fairgrounds' AND state = 'MA';

UPDATE venues
SET city = 'Lancaster', updated_at = unixepoch()
WHERE city = 'Fairgrounds at Lancaster' AND state = 'MA';

UPDATE venues
SET city = 'West Springfield', updated_at = unixepoch()
WHERE city = 'West Springfield Big-E Grounds' AND state = 'MA';

-- OPE-601 — normalize the `users.email` identity key to lowercase.
--
-- Nine rows are stored with a capital letter. Eight of them are the ONLY
-- account that person has, and for those eight the case mismatch is a silent
-- total lockout: `forgot-password` lowercases its input and then matches
-- `eq(users.email, …)` against a row stored capitalised, so it never matches —
-- and that route returns GENERIC_OK whether or not the address is known, for
-- enumeration safety. They cannot sign in unless they reproduce their own
-- capitalisation exactly, cannot reset, and are told nothing is wrong.
--
--   Angelacurtis14@aol.com            Marleny.Abreu@unitedwayri.org
--   Carolcohen173@gmail.com           Menageriestudio293@gmail.com
--   Leavienessa@gmail.com             Queenofcupsapothecary@gmail.com
--   jim@mfeSelfDefense.com            shazad.chikliwala@moreA2.com
--
-- The ninth is `Admin@kewlkandylz.com` — Jan Merrill's duplicate, the only
-- LOWER(email) collision in 7,494 rows. The NOT EXISTS clause deliberately
-- skips it: lowercasing it would violate the existing UNIQUE(email) index and
-- abort the whole migration. Resolving that pair means deleting a real user
-- row, which is an operator decision and is raised on the issue rather than
-- taken here. Her lockout is fixed by the code change regardless — her live
-- account is stored lowercase, so a normalized login now finds it.
--
-- Idempotent: re-running matches nothing, because every row it touches then
-- satisfies `email = LOWER(email)`.
--
-- No-op on an empty database — a bare UPDATE with no FK dependency, so a fresh
-- CI-built D1 applies it without an abort.
--
-- NOTE: the unique index on LOWER(email) that OPE-601 scope 6 asks for is NOT
-- created here. It cannot be, while the collision above exists — SQLite would
-- refuse to build it. It ships with the pair's resolution.

UPDATE users
   SET email = LOWER(email)
 WHERE email <> LOWER(email)
   AND NOT EXISTS (
     SELECT 1 FROM users u2
      WHERE u2.id <> users.id
        AND LOWER(u2.email) = LOWER(users.email)
   );

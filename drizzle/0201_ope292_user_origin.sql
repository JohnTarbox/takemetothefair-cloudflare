-- OPE-292 — mark ingestion-created placeholder accounts explicitly.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned.
--
-- ---------------------------------------------------------------------------
-- Why a column and not the email convention
-- ---------------------------------------------------------------------------
--
-- Re-measured 2026-08-17 (the ticket's 07-28 figures had moved, as expected):
--
--   users total                                     6,950
--   pending+<slug>@meetmeatthefair.com placeholders  6,741   (97.0%)
--   real accounts                                      209
--   placeholders holding a password_hash                 0   <- security
--                                                            property still holds
--
-- The placeholders are correct and intentional: the vendor / promoter creation
-- tools mint an owner row per entity. They are simply not registrations. Any
-- metric counting `users` without excluding them reports ~33x the real figure.
--
-- Until now the ONLY way to tell them apart was
-- `email LIKE 'pending+%@meetmeatthefair.com'` — a convention nothing enforced,
-- nothing documented as load-bearing, and which any new query silently forgets.
-- OPE-177 scope #3 (alert on unconfirmed verification emails) would have fired
-- constantly from day one, because placeholders are permanently and correctly
-- `email_verified = NULL`. That was caught by accident, which is not a control.
--
-- ---------------------------------------------------------------------------
-- Default direction is deliberate
-- ---------------------------------------------------------------------------
--
-- `DEFAULT 'registration'`. A real signup whose write path forgets to set
-- `origin` is counted as a person — the safe failure. The inverse default would
-- mean a forgotten signup vanishes from every user surface, which is
-- unrecoverable without an audit; a miscounted placeholder is merely noise, and
-- noise this backfill already knows how to find.
--
-- ---------------------------------------------------------------------------
-- Idempotency and rollback
-- ---------------------------------------------------------------------------
--
-- The UPDATE is self-limiting: it only touches rows still at the default, so a
-- re-run matches nothing, and a row an operator has since re-classified by hand
-- is left alone rather than clobbered.
--
-- Rollback is `UPDATE users SET origin = 'registration'` — the email pattern
-- remains intact and unmodified, so the classification can always be re-derived
-- from it. Nothing is destroyed here; a column is added alongside the existing
-- signal rather than replacing it.
--
-- NOT deleting anything: these are legitimate owner rows for real vendor and
-- promoter records.

ALTER TABLE users ADD COLUMN origin TEXT NOT NULL DEFAULT 'registration';

UPDATE users
SET origin = 'ingestion'
WHERE email LIKE 'pending+%@meetmeatthefair.com'
  AND origin = 'registration';

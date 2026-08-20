-- OPE-292 — relabel the placeholder users that a missed writer left as registrations.
--
-- PR #900 added `users.origin` and stamped `create_vendor` and `create_promoter`.
-- It missed a THIRD writer, `createOrLinkVendor` in packages/vendor-linking,
-- because the accompanying audit enumerated `from(users)` sites across `src/`
-- and `mcp-server/src/` and never reached `packages/`.
--
-- Between 2026-08-18 22:09 and 2026-08-20 00:20 that writer minted 389
-- placeholder rows into the `registration` partition. Measured before this ran:
--
--   origin='ingestion'      6,746 rows,  6,746 placeholders (100%)
--   origin='registration'     608 rows,    389 placeholders (64%)
--
-- So the column was wrong in exactly the way it was introduced to prevent: a
-- real-user count read off `origin='registration'` was 64% noise and worsening
-- daily. The writer is fixed in the same change; this repairs what it wrote.
--
-- ── Why this is safe to run, and safe to re-run ─────────────────────────
--
-- Keyed on BOTH the origin and the email shape, so it can only ever move rows
-- that are already provably placeholders. It cannot touch a real registration:
-- a genuine signup at `pending+…@meetmeatthefair.com` is not a thing the public
-- form can produce (the address is minted server-side from a vendor slug), and
-- any row already `ingestion` is excluded by the WHERE.
--
-- Idempotent by construction — a second run matches zero rows, because the
-- first run moved them all out of `origin='registration'`.
--
-- Pure UPDATE against an existing table with no foreign keys involved, so it is
-- a clean no-op against the empty D1 that CI builds from migrations.
--
-- Rollback, should it ever be wanted: the email pattern is left intact, so the
-- classification is re-derivable and the inverse is one UPDATE.

UPDATE users
SET origin = 'ingestion'
WHERE origin = 'registration'
  AND email LIKE 'pending+%@meetmeatthefair.com';

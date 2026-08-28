-- OPE-601 scopes 5 + 6 — AUTHORIZED BY JOHN on the issue, 2026-08-28:
--   "Remove the duplicate row 96142359 (Admin@kewlkandylz.com)… Retain
--    b670e4ac (Jan Merrill's real account that owns kewl-kandylz) unchanged."
--   "Add the unique index on LOWER(email). Ships in the same PR, since it
--    cannot build while the pair exists."
--
-- ── Why a deletion needs this much comment ────────────────────────────────
-- This removes a real person's row and it is NOT REVERSIBLE. The full record,
-- captured from prod immediately before writing this migration, so the row can
-- be reconstructed by hand if the decision is ever revisited:
--
--   id         96142359-378b-4454-b172-0824be7b85bc
--   email      Admin@kewlkandylz.com
--   name       Jan Merrill
--   role       VENDOR
--   created_at 1786123181            (2026-08-07)
--   verified   NO  (email_verified IS NULL)
--
-- The keeper is `b670e4ac-79e1-415e-90b3-87c2ee7e3157` — same person, same
-- mailbox in lowercase, VERIFIED, created 2026-07-16, and the owner of the
-- `kewl-kandylz` vendor row.
--
-- ── Verified independently before writing, not taken on trust ─────────────
-- `vendors.user_id` cascades on delete, so a row that owned a vendor would
-- take the vendor with it. Counted against prod for THIS id across every table
-- that references `users.id`:
--
--   vendors 0 · promoters 0 · performers 0 · accounts 0 · sessions 0
--   notifications 0 · api_tokens 0 · user_favorites 0 · entity_claims 0
--
-- and the keeper still owns its 1 vendor row. The duplicate is inert: it owns
-- nothing, was never verified, and since migration 0245 login folds input to
-- lowercase, so it is unreachable as a sign-in target.
--
-- ── The guards ARE the rollback plan ──────────────────────────────────────
-- Every condition below is re-checked AT APPLY TIME. If the row has acquired
-- any ownership between this being written and the migration running, the
-- DELETE matches nothing and the index creation then FAILS LOUDLY on the
-- surviving collision — which aborts the deploy and puts a human in front of
-- it. That is the correct failure direction for a destructive statement: a
-- noisy stop, never a quiet deletion of something that turned out to matter.
--
-- IDEMPOTENT: re-running matches nothing and the index is IF NOT EXISTS.
-- NO-OP ON AN EMPTY DB: CI applies every migration to a fresh D1 — the DELETE
-- matches nothing there and the index builds on an empty table.
DELETE FROM users
 WHERE id = '96142359-378b-4454-b172-0824be7b85bc'
   AND email = 'Admin@kewlkandylz.com'
   AND email_verified IS NULL
   AND NOT EXISTS (SELECT 1 FROM vendors        v WHERE v.user_id = users.id)
   AND NOT EXISTS (SELECT 1 FROM promoters      p WHERE p.user_id = users.id)
   AND NOT EXISTS (SELECT 1 FROM performers     f WHERE f.user_id = users.id)
   AND NOT EXISTS (SELECT 1 FROM user_favorites u WHERE u.user_id = users.id)
   AND NOT EXISTS (SELECT 1 FROM entity_claims  c WHERE c.user_id = users.id);

-- Scope 6 — the drift guard. `users.email` already carries a plain UNIQUE
-- index, which is exactly why this class of duplicate could exist at all:
-- `Admin@` and `admin@` are distinct strings and collide only under folding.
-- This index makes the identity rule the code now enforces (OPE-601's
-- `normalizeEmail`) true at the storage layer too, so the two cannot drift
-- apart again the way they did between the login and forgot-password paths.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

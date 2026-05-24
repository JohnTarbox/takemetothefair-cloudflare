-- Dual-role support — user_roles is the canonical many-to-many of which
-- roles a user has been granted. The existing users.role column stays as
-- the "primary" role for back-compat with the ~100 existing
-- `session.user.role === X` consumers; PR 2 will sweep those to use the
-- new hasRole() helper that reads this table. Backfill below preserves
-- the current single-role-per-user state exactly.
--
-- Grants happen via two paths post-PR-1:
--   1. **Self-service email-match claim** — when a user with a verified
--      email visits a vendor/promoter page whose contact_email matches
--      theirs, one-click claim writes both the entity (vendors.claimed=1
--      etc.) and a row here for the corresponding role.
--   2. **Admin override** — MCP tool set_user_roles (planned PR 3) for
--      cases the email-match doesn't cover.
--
-- The UNIQUE(user_id, role) makes re-grants idempotent. ON DELETE
-- CASCADE on user_id means deleting a user wipes their grants; granted_by
-- is informational (who did the grant) and SET NULL on the granter's
-- deletion so audit isn't tied to current-existence of the granter.

CREATE TABLE user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('USER', 'VENDOR', 'PROMOTER', 'ADMIN')),
  granted_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Named unique index (matches the Drizzle schema's uniqueIndex
-- declaration so future drizzle-kit diffs stay clean).
CREATE UNIQUE INDEX user_roles_user_role_unique ON user_roles(user_id, role);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role);

-- Backfill: every existing user with a non-null role gets exactly one
-- row matching their current role. lower(hex(randomblob(16))) gives a
-- unique-enough id without needing crypto.randomUUID(). granted_at is
-- backdated to the user's created_at when available (otherwise now), so
-- the audit trail isn't distorted to "everyone got granted today."
INSERT INTO user_roles (id, user_id, role, granted_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  role,
  COALESCE(created_at, unixepoch('now'))
FROM users
WHERE role IS NOT NULL;

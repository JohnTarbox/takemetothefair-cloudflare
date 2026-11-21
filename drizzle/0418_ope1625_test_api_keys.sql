-- OPE-1625 — promoter API TEST keys: a key that can never publish. Every write
-- endpoint called with a test key answers the dry-run report, and the route is
-- handed a read-only database, so a write throws even on a route that forgets.
-- Additive column with a default: a no-op on an empty database.
ALTER TABLE promoter_api_keys ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

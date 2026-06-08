-- IMG1 §1b Phase 1 (2026-06-08): per-image focal-point override.
--
-- Adds `image_focal_x` / `image_focal_y` (REAL, range 0.0–1.0, default
-- 0.5/0.5 = center) to all four entity types that carry user-visible
-- images. Mirrors Eventbrite's `fp-x`/`fp-y` pattern and feeds Cloudflare
-- `cdn-cgi/image`'s `gravity=XxY` syntax (see
-- https://developers.cloudflare.com/images/transform-images/transform-via-url/
-- for the format — `0.5x0.5` is center, `0.0x0.0` is top-left).
--
-- Coverage:
--   - events     — applies to image_url (hero / card image)
--   - venues     — applies to image_url (venue photo)
--   - vendors    — applies to logo_url (logo crop when the logo isn't square)
--   - promoters  — applies to logo_url (same)
--
-- Why uniform column names across logo-vs-image-bearing entities: the
-- column stores a focal point (a pair of floats); the consumer decides
-- which URL it crops. Keeps the cdnImage call sites uniform and lets
-- future migrations add e.g. a brand-photo image_url to vendors/promoters
-- without renaming columns.
--
-- Defaults are NOT NULL DEFAULT 0.5, so:
--   - Every existing row becomes effective center-crop on first read
--     (the pre-IMG1 behavior). Zero behavioral change shipping this
--     migration alone — render plumbing in the same PR is what activates
--     the per-image override.
--   - cdnImage helper short-circuits the `gravity` arg when x=0.5 AND
--     y=0.5 so center-defaulted images get the same cache key they had
--     before (avoids invalidating the entire image-cache on rollout).
--
-- No CHECK constraints on the (0,1) range — SQLite CHECK constraints
-- can't be added/removed on existing tables without a table-rewrite, and
-- the validation lives at the Zod schema boundary anyway (clamped on
-- write via image-focal-point validator). Defense in depth: any bad
-- value that bypasses the validator will be clamped in the cdnImage
-- helper before reaching Cloudflare.
--
-- See [[feedback_alter_table_not_idempotent]]: ALTER TABLE ADD COLUMN
-- has no IF NOT EXISTS in SQLite. If this migration is partially
-- applied (e.g. interrupted mid-deploy), the safe recovery is:
--   PRAGMA table_info(<table>); -- inspect what landed
-- then re-run only the missing ALTERs by hand.

ALTER TABLE events ADD COLUMN image_focal_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE events ADD COLUMN image_focal_y REAL NOT NULL DEFAULT 0.5;

ALTER TABLE venues ADD COLUMN image_focal_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE venues ADD COLUMN image_focal_y REAL NOT NULL DEFAULT 0.5;

ALTER TABLE vendors ADD COLUMN image_focal_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE vendors ADD COLUMN image_focal_y REAL NOT NULL DEFAULT 0.5;

ALTER TABLE promoters ADD COLUMN image_focal_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE promoters ADD COLUMN image_focal_y REAL NOT NULL DEFAULT 0.5;

-- F1 (Dev-Email-2026-06-08 §F.1, 2026-06-08) — blog_posts focal-point
-- columns.
--
-- Mirrors the drizzle/0115 pattern that added image_focal_x / image_focal_y
-- to events, venues, vendors, promoters. F1 closes the gap: blog_posts is
-- the last entity type in the focal-point system. Once this migration +
-- the read-side gravity arg in BlogPostCard land, an editor who places
-- the dot on the featured image gets a stable crop in every responsive
-- size the card renders.
--
-- Default 0.5/0.5 = center, which is the prior implicit behavior — so
-- existing rows render identically to pre-F1 (per
-- focalPointGravity()'s short-circuit at center, this keeps the
-- pre-IMG1 derivative cache key intact and avoids re-billing CF
-- transformations).

ALTER TABLE blog_posts ADD COLUMN image_focal_x REAL NOT NULL DEFAULT 0.5;
ALTER TABLE blog_posts ADD COLUMN image_focal_y REAL NOT NULL DEFAULT 0.5;

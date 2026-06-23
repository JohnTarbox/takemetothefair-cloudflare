-- Blog homepage ranking (2026-06-23) — two ranking inputs on blog_posts so the
-- homepage "Latest from the Blog" section can move off pure recency (which had
-- degenerated: the whole 103-post corpus published in a ~2-month burst, so the
-- "3 newest" had been frozen + arbitrary for 18 days). See
-- src/lib/blog/homepage-ranking.ts for the weighted scorer that consumes these.
--
--   view_count  coarse popularity signal. Incremented inline on the ISR-cached
--               blog detail render (mirrors events/vendors.view_count) — so it
--               counts regenerations, not raw views: a RELATIVE signal, fine for
--               ranking. Upgrade path (true counts via GA4 sync / client beacon)
--               can repopulate this column without touching the scorer.
--   featured    editorial pin. 0/1. Feeds the scorer as a strong weighted boost
--               (FEATURED in homepage-ranking.ts), not a hard override — a very
--               timely + popular post can still edge out a featured one.
--
-- SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS; idempotency is at the
-- migration-file level (wrangler records applied filenames in d1_migrations).
-- Do NOT apply out-of-band — deploy.yml's d1-migrate step owns application.
-- Verify after deploy:  PRAGMA table_info('blog_posts');
ALTER TABLE blog_posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blog_posts ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_blogposts_status_featured ON blog_posts (status, featured);

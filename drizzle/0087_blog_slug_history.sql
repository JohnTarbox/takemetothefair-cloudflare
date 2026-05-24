-- Blog slug change history — for 301-redirecting old URLs after a blog post
-- slug changes. Mirrors drizzle/0061_event_slug_history.sql verbatim except
-- that the FK points at blog_posts(id) and the column / index names are
-- prefixed accordingly.
--
-- Two write paths land rows here:
--   1. PUT /api/blog-posts/[slug] when a title change causes the slug to
--      regenerate (the gap that 404'd old URLs after a rename until now).
--   2. DELETE /api/blog-posts/[slug]?successor=<slug> for the consolidation
--      case (e.g. the May 2026 Paradise City duplicate). blog_post_id is
--      stored as the SUCCESSOR post's id so the FK and the cascade behave
--      sensibly — if the successor is later deleted itself, the inherited
--      redirect dies with it (at which point we'd want a 410, not a 301).
--
-- The /blog/[slug] middleware consults this table on slug-not-found and
-- 301-redirects to the current slug. Chains are followed up to 5 hops to
-- handle multiple consecutive renames.

CREATE TABLE blog_slug_history (
  id TEXT PRIMARY KEY,
  blog_post_id TEXT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  -- Optional admin user id (or NULL for system writes — e.g. seeded rows).
  changed_by TEXT
);

CREATE INDEX idx_blog_slug_history_old_slug ON blog_slug_history(old_slug);
CREATE INDEX idx_blog_slug_history_blog_post_id ON blog_slug_history(blog_post_id);

-- One-off seed for the Paradise City consolidation flagged in the analyst's
-- 2026-05-24 report. paradise-city-arts-festival-2026-spring-fall-show-guide
-- was deleted; its URL hard-404'd because no slug-history mechanism existed.
-- This row installs the redirect retroactively. Conditional INSERT so it's
-- a no-op in environments where the successor post doesn't exist (local
-- dev, fresh test DBs, etc.).
INSERT INTO blog_slug_history (id, blog_post_id, old_slug, new_slug, changed_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  'paradise-city-arts-festival-2026-spring-fall-show-guide',
  slug,
  unixepoch('now')
FROM blog_posts
WHERE slug = 'paradise-city-arts-festival-vendors-and-visitors-guide';

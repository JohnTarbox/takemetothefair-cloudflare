-- Phase: content-entity link index
-- Persists which blog posts reference which events/vendors/venues by slug.
-- Re-derived from blog_posts.body on every save — never manually edited.

CREATE TABLE IF NOT EXISTS content_links (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('BLOG_POST')),
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('EVENT', 'VENDOR', 'VENUE')),
  target_slug TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

-- Prevent duplicate (source, target) pairs for clean upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_links_unique
  ON content_links(source_type, source_id, target_type, target_slug);

-- Forward lookup: "which posts link to this event/vendor/venue?"
CREATE INDEX IF NOT EXISTS idx_content_links_target_id
  ON content_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_links_target_slug
  ON content_links(target_type, target_slug);

-- Reverse lookup: "what does this post link to?"
CREATE INDEX IF NOT EXISTS idx_content_links_source
  ON content_links(source_type, source_id);

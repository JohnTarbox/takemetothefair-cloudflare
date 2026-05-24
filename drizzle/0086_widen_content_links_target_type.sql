-- Widens content_links.target_type to include BLOG_POST so blog-to-blog
-- internal links can be tracked alongside event/vendor/venue references.
--
-- SQLite cannot ALTER a CHECK constraint in place, so the standard idiom
-- is: create a parallel table with the desired constraint, copy rows over,
-- drop the original, rename. content_links has no FK relationships in
-- either direction, so we skip the PRAGMA foreign_keys ceremony.
--
-- Column order in content_links_new MUST match the original definition
-- (0031 + 0032 added notified_at) so `INSERT INTO ... SELECT *` lines up.

CREATE TABLE content_links_new (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('BLOG_POST')),
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('EVENT', 'VENDOR', 'VENUE', 'BLOG_POST')),
  target_slug TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  notified_at INTEGER
);

INSERT INTO content_links_new SELECT * FROM content_links;

DROP TABLE content_links;

ALTER TABLE content_links_new RENAME TO content_links;

CREATE UNIQUE INDEX idx_content_links_unique
  ON content_links(source_type, source_id, target_type, target_slug);
CREATE INDEX idx_content_links_target_id
  ON content_links(target_type, target_id);
CREATE INDEX idx_content_links_target_slug
  ON content_links(target_type, target_slug);
CREATE INDEX idx_content_links_source
  ON content_links(source_type, source_id);

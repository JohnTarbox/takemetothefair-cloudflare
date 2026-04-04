CREATE TABLE blog_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  excerpt TEXT,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tags TEXT DEFAULT '[]',
  categories TEXT DEFAULT '[]',
  featured_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  publish_date INTEGER,
  meta_title TEXT,
  meta_description TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
--> statement-breakpoint
CREATE INDEX idx_blogposts_status_publishdate ON blog_posts(status, publish_date);
--> statement-breakpoint
CREATE INDEX idx_blogposts_slug ON blog_posts(slug);
--> statement-breakpoint
CREATE INDEX idx_blogposts_authorid ON blog_posts(author_id);

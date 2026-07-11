-- OPE-170 / OPE-169 — persist each sent newsletter issue so it has a public
-- web page (/newsletter/{slug}) and a "view in browser" URL. Written by the
-- broadcast send path (OPE-169) at send time; read by the public archive
-- (OPE-170). `html` is the fully-rendered issue body (shared shell adds the
-- site chrome on the web page).
CREATE TABLE newsletter_issues (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  sent_at INTEGER,
  created_at INTEGER
);
CREATE INDEX idx_newsletter_issues_sent_at ON newsletter_issues (sent_at);

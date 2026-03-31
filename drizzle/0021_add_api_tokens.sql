CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'Default',
  last_used_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
--> statement-breakpoint
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE error_logs (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  level TEXT NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  context TEXT DEFAULT '{}',
  url TEXT,
  method TEXT,
  status_code INTEGER,
  stack_trace TEXT,
  user_agent TEXT,
  source TEXT
);
CREATE INDEX idx_error_logs_timestamp ON error_logs(timestamp);
CREATE INDEX idx_error_logs_level ON error_logs(level);
CREATE INDEX idx_error_logs_source ON error_logs(source);

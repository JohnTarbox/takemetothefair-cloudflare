-- OPE-1585: what each change-gated operator digest last reported, so a digest
-- can send only when its contents change. One row per digest; additive.
CREATE TABLE IF NOT EXISTS digest_change_state (
  key TEXT PRIMARY KEY NOT NULL,
  counts_json TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL
);

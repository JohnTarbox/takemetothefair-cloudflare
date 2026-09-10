-- OPE-903 — give `mmatf_` API tokens a lifecycle.
--
-- Until now `api_tokens` was id / user_id / token_hash / name / last_used_at /
-- created_at. There was no way to revoke a token except deleting its row by
-- hand, and no way to give one an expiry at all -- while every one of them
-- reaches the admin MCP tools (OPE-478).
--
-- Both columns are NULLABLE with no default, deliberately: every existing row
-- keeps working, unchanged, until somebody deliberately acts on it. NULL
-- expires_at means "never expires"; NULL revoked_at means "not revoked". A
-- hardening migration that logs anyone out is a worse outcome than the gap it
-- closes.
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
--> statement-breakpoint
ALTER TABLE api_tokens ADD COLUMN revoked_at INTEGER;

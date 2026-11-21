-- OPE-1682 — a registered promoter can opt in to listing its camps and
-- workshops from its own calendar feed. Off by default; the feed reader applies
-- it only while the promoter is registered (claimed with a linked user), per
-- John's ruling of 2026-11-18. Set with the set_promoter_camps_workshops MCP tool.
-- Additive column with a constant default: a no-op on an empty database.
ALTER TABLE promoters ADD COLUMN include_camps_workshops INTEGER NOT NULL DEFAULT 0;

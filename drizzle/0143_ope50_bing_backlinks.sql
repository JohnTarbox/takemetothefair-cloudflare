-- OPE-50 (bing referring-domains import, 2026-07-02) — imported BWT
-- "Referring Domains" CSV snapshots.
--
-- Bing's API exposes NO backlink data (GetLinkCounts / GetUrlLinks /
-- GetConnectedPages all returned empty when live-probed 2026-07-02), so the
-- operator exports the Bing Webmaster Tools "Referring Domains" report and
-- imports it here via the import_bing_backlinks MCP tool /
-- POST /api/admin/analytics/bing/backlinks/import. The admin Bing tab and
-- get_bing_backlinks read the most-recent snapshot.
--
--   id               → TEXT PK (randomUUID).
--   referring_domain → NORMALISED bare host (scheme + leading www. + trailing
--                      slash stripped) — e.g. "https://www.msn.com/" → "msn.com".
--   backlink_count   → integer from the CSV's "Backlinks Count" column.
--   snapshot_date    → UTC YYYY-MM-DD of the import; growth is trackable across
--                      snapshots. UNIQUE(referring_domain, snapshot_date) is the
--                      upsert key.
--   created_at       → unix-seconds timestamp of the row insert.
--
-- Purely additive; no writes to existing tables. Rollback: DROP TABLE bing_backlinks.
CREATE TABLE `bing_backlinks` (
	`id` text PRIMARY KEY NOT NULL,
	`referring_domain` text NOT NULL,
	`backlink_count` integer NOT NULL,
	`snapshot_date` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_bing_backlinks_domain_snapshot` ON `bing_backlinks` (`referring_domain`,`snapshot_date`);
--> statement-breakpoint
CREATE INDEX `idx_bing_backlinks_snapshot_date` ON `bing_backlinks` (`snapshot_date`);

-- OPE-91 (blog indexation — Bing per-URL store, 2026-07-04) — hand-authored per
-- the OPE-21 migration workflow (numbering owned by the orchestrator; deploy
-- applies via `wrangler d1 migrations apply` by filename — no meta snapshot
-- needed). Latest migration is 0150; this is 0151.
--
-- The Bing analogue of `gsc_inspection_state`: per-URL indexation status pulled
-- from Bing Webmaster Tools' GetUrlInfo by the daily Bing inspection sweep
-- (src/lib/bing-inspection-sweep.ts). Read by the /admin/blog "Bing" column so
-- an operator can see whether Bing has each post indexed alongside the existing
-- Google indexation column. Blog-first: the sweep keys `${HOST}/blog/${slug}`.
--
--   url             → TEXT PK, the fully-qualified URL (matches the gsc table).
--   is_indexed      → boolean-mode integer; TRUE when Bing has a real crawl date
--                     for the URL (derived from GetUrlInfo LastCrawledDate, NOT
--                     the misleading IsPage flag — see getUrlInfo). NULL until
--                     the URL is first swept.
--   last_crawled    → seconds-epoch (mode:"timestamp"); Bing's LastCrawledDate.
--   crawl_error     → Bing's CrawlError text, if any.
--   last_checked_at → seconds-epoch; when this sweep last called GetUrlInfo for
--                     the URL. Drives least-recently-checked rotation.
--
-- Purely additive; no writes to existing tables. Rollback: DROP TABLE bing_inspection_state.
CREATE TABLE `bing_inspection_state` (
	`url` text PRIMARY KEY NOT NULL,
	`is_indexed` integer,
	`last_crawled` integer,
	`crawl_error` text,
	`last_checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bing_inspection_state_stale` ON `bing_inspection_state` (`last_checked_at`);

-- OPE-76 (CPI Move 2 — auto-file rail, 2026-07-03) — hand-authored per the
-- OPE-21 migration workflow (numbering owned by the orchestrator; deploy applies
-- via `wrangler d1 migrations apply` by filename — no meta snapshot needed).
-- NOTE: 0148 is reserved by the in-flight OPE-77 PR; this is 0149.
--
-- The filing ledger behind auto-filing dashboard signals as OPE issues. A
-- Cloudflare Worker CANNOT call the Linear `save_issue` agent tool and there is
-- no Linear token in this codebase, so the developer builds the RAIL (dedup +
-- rate-cap + resolution ledger) and a scheduled agent run (per CPI design §35)
-- does the actual filing. This table is that ledger.
--
--   fingerprint       → TEXT PK, stable per signal (`cpi:<source>:<refKey>`), so
--                       a flapping signal maps to ONE row across scans (dedup).
--   priority/title/href → snapshot of the signal for the agent + audit trail.
--   first_detected_at → seconds-epoch (mode:"timestamp"); when the signal entered
--                       its bad state. Nullable (recommendation signals have none).
--   last_seen_at      → seconds-epoch; bumped every scan the signal is still fileable.
--   status            → 'proposed' (surfaced, awaiting a file) | 'filed' (agent
--                       opened an OPE) | 'resolved' (signal returned to green).
--   ope_id            → the filed OPE issue id, written back by the agent.
--   filed_at          → seconds-epoch; set when the agent records the OPE id.
--   resolved_at       → seconds-epoch; set when the signal drops out of the set.
--   created_at        → seconds-epoch of the first proposal; preserved on reopen.
--
-- Purely additive; no writes to existing tables. Rollback: DROP TABLE cpi_signal_filings.
CREATE TABLE `cpi_signal_filings` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`priority` text NOT NULL,
	`title` text NOT NULL,
	`href` text NOT NULL,
	`first_detected_at` integer,
	`last_seen_at` integer NOT NULL,
	`status` text NOT NULL,
	`ope_id` text,
	`filed_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cpi_signal_filings_status` ON `cpi_signal_filings` (`status`);

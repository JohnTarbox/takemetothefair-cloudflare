-- OPE-81 (render-fault detect→group→dedup→emit rail, 2026-07-03) — hand-authored
-- per the OPE-21 migration workflow (numbering owned by the orchestrator; deploy
-- applies via `wrangler d1 migrations apply` by filename — no meta snapshot needed).
-- Latest migration is 0149; this is 0150.
--
-- The ledger behind grouping render faults (from `error_logs`) into ONE unit of
-- work per fault. A Cloudflare Worker CANNOT call the Linear `save_issue` agent
-- tool and there is no Linear token in this codebase, so the developer builds the
-- RAIL (signature + threshold + dedup + regression ledger) and a scheduled analyst
-- agent run does the actual filing. This table is that ledger.
--
--   signature   → TEXT PK, stable per fault (`route#error-class`), so a recurring
--                 fault maps to ONE row across scans (dedup).
--   route       → snapshot of the offending route for readability/filtering.
--   error_class → the normalized, volatile-token-stripped error class.
--   first_seen  → seconds-epoch (mode:"timestamp"); first occurrence observed.
--   last_seen   → seconds-epoch; most recent occurrence observed, bumped per scan.
--   count       → total occurrences observed across scans.
--   status      → 'proposed' (surfaced, awaiting a file) | 'filed' (agent opened
--                 an OPE) | 'done' (resolved) | 'regressed' (recurred after done).
--   ope_id      → the filed OPE issue id, written back by the agent.
--   filed_at    → seconds-epoch; set when the agent records the OPE id.
--   resolved_at → seconds-epoch; set when the signature is marked done.
--   created_at  → seconds-epoch of the first proposal; preserved on reopen.
--
-- Purely additive; no writes to existing tables. Rollback: DROP TABLE fault_signatures.
CREATE TABLE `fault_signatures` (
	`signature` text PRIMARY KEY NOT NULL,
	`route` text,
	`error_class` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`count` integer NOT NULL,
	`status` text NOT NULL,
	`ope_id` text,
	`filed_at` integer,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fault_signatures_status` ON `fault_signatures` (`status`);

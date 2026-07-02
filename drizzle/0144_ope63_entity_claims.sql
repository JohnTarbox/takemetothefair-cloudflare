-- OPE-63 (claim-program KEYSTONE data model, 2026-07-02) — hand-authored
-- per the OPE-21 migration workflow (numbering owned by the orchestrator).
--
-- Three coupled changes:
--   1. entity_claims — the KEYSTONE table. One row per user attempt to claim an
--      entity. `entity_id` is POLYMORPHIC (vendors.id / promoters.id / venues.id
--      by `entity_type`) so there is intentionally NO foreign key on it.
--   2. vendor_claim_tokens → claim_tokens — generalizes the old vendor-only
--      token table (drizzle/0050) to any entity via the polymorphic
--      (entity_type, entity_id) pair. The old table has 0 rows in prod, so a
--      DROP + CREATE is safe and loses nothing.
--   3. promoters gains claimed / claimed_at / claimed_by — parity with the
--      vendors.claimed trio (drizzle/0049), driving the promoter claim program.
--
-- Rollback:
--   DROP TABLE entity_claims;
--   DROP TABLE claim_tokens;
--   CREATE TABLE vendor_claim_tokens (              -- restore drizzle/0050 shape
--     id TEXT PRIMARY KEY NOT NULL,
--     vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
--     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     token_hash TEXT NOT NULL UNIQUE,
--     created_at INTEGER NOT NULL,
--     expires_at INTEGER NOT NULL
--   );
--   CREATE INDEX idx_vendor_claim_tokens_vendor ON vendor_claim_tokens(vendor_id);
--   CREATE INDEX idx_vendor_claim_tokens_expires ON vendor_claim_tokens(expires_at);
--   -- SQLite can't DROP COLUMN pre-3.35 cleanly across all envs; leaving the
--   -- promoters.claimed* columns in place is harmless on rollback.

-- 1. entity_claims (KEYSTONE) --------------------------------------------------
CREATE TABLE `entity_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`evidence` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_entity_claims_entity` ON `entity_claims` (`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `idx_entity_claims_user` ON `entity_claims` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_entity_claims_status` ON `entity_claims` (`status`);
--> statement-breakpoint

-- 2. vendor_claim_tokens → claim_tokens (0 rows in prod; safe drop) ------------
DROP TABLE `vendor_claim_tokens`;
--> statement-breakpoint
CREATE TABLE `claim_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_tokens_token_hash_unique` ON `claim_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_claim_tokens_entity` ON `claim_tokens` (`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `idx_claim_tokens_expires` ON `claim_tokens` (`expires_at`);
--> statement-breakpoint

-- 3. promoters claim columns (parity with vendors.claimed trio) ----------------
ALTER TABLE `promoters` ADD COLUMN `claimed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `promoters` ADD COLUMN `claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `promoters` ADD COLUMN `claimed_by` text REFERENCES users(id) ON DELETE set null;

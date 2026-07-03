-- OPE-67 — claim_tokens: support COLD invites (create_claim_invite).
--
-- The invite campaign targets vendor/promoter listings by their contact email,
-- which has NO account yet. The 0144 claim_tokens shape required a NOT NULL
-- user_id (FK users.id), which cannot exist at invite time. This migration:
--   1. makes user_id NULLABLE, and
--   2. adds an `email` column (the invited address for a cold invite).
-- user_id is filled at redemption (once the invitee signs up with that email),
-- which is also when the entity_claims INVITE_TOKEN row is written (that table
-- keeps its NOT NULL user_id — we do NOT loosen the keystone).
--
-- claim_tokens has 0 rows in prod (it has never had a row — the vendor-only
-- predecessor was DROP+CREATE'd empty in 0144), so a DROP + CREATE is safe and
-- loses nothing. SQLite cannot ALTER COLUMN to drop NOT NULL, so a rebuild is
-- the clean path for an empty table.
--
-- Rollback:
--   DROP TABLE claim_tokens;
--   CREATE TABLE `claim_tokens` (
--     `id` text PRIMARY KEY NOT NULL,
--     `entity_type` text NOT NULL,
--     `entity_id` text NOT NULL,
--     `user_id` text NOT NULL REFERENCES users(id) ON DELETE cascade,
--     `token_hash` text NOT NULL UNIQUE,
--     `created_at` integer NOT NULL,
--     `expires_at` integer NOT NULL
--   );
--   CREATE INDEX `idx_claim_tokens_entity` ON `claim_tokens` (`entity_type`,`entity_id`);
--   CREATE INDEX `idx_claim_tokens_expires` ON `claim_tokens` (`expires_at`);

DROP TABLE IF EXISTS `claim_tokens`;
--> statement-breakpoint
CREATE TABLE `claim_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`user_id` text,
	`email` text,
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

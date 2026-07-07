-- OPE-113 (performer tracking — Phase 1, 2026-07-06) — hand-authored per the
-- OPE-21 migration workflow. Latest migration is 0152; this is 0153.
--
-- Reconciliation of the OPE-112 Phase-0 migration against the design doc §3.1:
-- the ticket's inline column list omitted the two verify-audit columns that the
-- doc lists (mirroring vendors.verified_pro_at / verified_pro_by). Additive only;
-- the performers table is empty in prod, so no data risk.
-- Rollback: (SQLite can't DROP COLUMN pre-3.35 cleanly) leave in place — unused
-- until the Phase-1 verify path writes them.
ALTER TABLE `performers` ADD COLUMN `verified_pro_at` integer;--> statement-breakpoint
ALTER TABLE `performers` ADD COLUMN `verified_pro_by` text REFERENCES users(id) ON DELETE set null;

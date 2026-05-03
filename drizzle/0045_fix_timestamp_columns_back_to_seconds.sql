-- Phase 7 (date architecture cleanup, corrective — 2026-05-02)
--
-- Migration 0043 was based on a wrong assumption about Drizzle's
-- integer({ mode: "timestamp" }) storage convention. The Drizzle docs
-- say:
--   * mode: "timestamp"     → stores Unix epoch SECONDS, reads as new Date(value * 1000)
--   * mode: "timestamp_ms"  → stores Unix epoch MILLISECONDS, reads as new Date(value)
--
-- The codebase has been using mode: "timestamp" (seconds) successfully
-- for years — events.startDate etc. work fine with this. My 0043
-- migration multiplied existing seconds values by 1000 thinking it was
-- bringing them up to ms-epoch, but the schema STILL interprets the
-- column as seconds, so reads now multiply by 1000 a second time.
-- Result: a 2026 timestamp displays as year 58305.
--
-- This corrective migration divides the inflated values back down by
-- 1000. It is idempotent: only touches values > 1e11 (which can only
-- be the broken-multiplied ones; legit seconds-epoch values today are
-- ~1.78e9, way below the guard).
--
-- New writes since PR #55 are CORRECT (Drizzle stores
-- Math.floor(date.getTime() / 1000) = seconds), so they're below the
-- guard and untouched.
--
-- Also fixes urlDomainClassifications which had the same bug from
-- migration 0040 (less visible because nothing renders those createdAt
-- timestamps — but the data should be correct).
--
-- IMPORTANT: backup taken before applying:
-- backups/takemetothefair-db_production_20260502_224900.sql

UPDATE analytics_events     SET timestamp         = timestamp         / 1000 WHERE timestamp         > 100000000000;
UPDATE indexnow_submissions SET timestamp         = timestamp         / 1000 WHERE timestamp         > 100000000000;
UPDATE error_logs           SET timestamp         = timestamp         / 1000 WHERE timestamp         > 100000000000;

UPDATE health_issues        SET first_detected_at = first_detected_at / 1000 WHERE first_detected_at > 100000000000;
UPDATE health_issues        SET last_detected_at  = last_detected_at  / 1000 WHERE last_detected_at  > 100000000000;
UPDATE health_issues        SET resolved_at       = resolved_at       / 1000 WHERE resolved_at       > 100000000000;

UPDATE health_issue_snoozes SET snoozed_until     = snoozed_until     / 1000 WHERE snoozed_until     > 100000000000;
UPDATE health_issue_snoozes SET snoozed_at        = snoozed_at        / 1000 WHERE snoozed_at        > 100000000000;

UPDATE gsc_inspection_state SET last_inspected_at = last_inspected_at / 1000 WHERE last_inspected_at > 100000000000;

UPDATE recommendation_items SET first_seen_at     = first_seen_at     / 1000 WHERE first_seen_at     > 100000000000;
UPDATE recommendation_items SET last_seen_at      = last_seen_at      / 1000 WHERE last_seen_at      > 100000000000;
UPDATE recommendation_items SET dismissed_at      = dismissed_at      / 1000 WHERE dismissed_at      > 100000000000 AND dismissed_at IS NOT NULL;
UPDATE recommendation_items SET dismissed_until   = dismissed_until   / 1000 WHERE dismissed_until   > 100000000000 AND dismissed_until IS NOT NULL;
UPDATE recommendation_items SET acted_at          = acted_at          / 1000 WHERE acted_at          > 100000000000 AND acted_at IS NOT NULL;

UPDATE recommendation_rules SET created_at        = created_at        / 1000 WHERE created_at        > 100000000000;

UPDATE url_domain_classifications SET created_at  = created_at        / 1000 WHERE created_at        > 100000000000;
UPDATE url_domain_classifications SET updated_at  = updated_at        / 1000 WHERE updated_at        > 100000000000;

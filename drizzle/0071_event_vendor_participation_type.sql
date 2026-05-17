-- participation_type splits "this vendor takes a booth" from "this vendor
-- is a sponsor only". Pre-2026-05-16, the `status` enum captured commitment
-- state (APPLIED / APPROVED / CONFIRMED / etc.) but not participation mode.
-- That meant sponsors-only relationships (logo on the program, no booth)
-- couldn't be expressed — analyst's example: Renewal by Andersen of Greater
-- Maine sponsored the Bangor Healthy Aging Expo without taking a booth.
--
-- Three values:
--   EXHIBITOR             — current implicit default; takes booth space
--   SPONSOR_ONLY          — logo/program presence, no booth
--   SPONSOR_AND_EXHIBITOR — both (rare but real, e.g. venue naming rights)
--
-- Existing rows default to EXHIBITOR — correct interpretation of historical
-- data; the few SPONSOR_AND_EXHIBITOR cases (RbA at Cross Insurance Center
-- etc.) get backfilled via an MCP-driven audit pass after this lands.
--
-- See plan doc /home/wa1kli/.claude/plans/please-plan-all-of-harmonic-petal.md
-- Analyst spec: MMATF-Spec-Event-Vendor-Participation-Type.md
-- Migration added 2026-05-16.

ALTER TABLE event_vendors ADD COLUMN participation_type TEXT NOT NULL DEFAULT 'EXHIBITOR'
  CHECK (participation_type IN ('EXHIBITOR', 'SPONSOR_ONLY', 'SPONSOR_AND_EXHIBITOR'));

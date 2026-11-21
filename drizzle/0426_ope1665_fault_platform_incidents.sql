-- OPE-1665 — a D1 platform incident (overload, CPU reset, connection lost,
-- storage timeout) is ONE fault_signatures row per burst, keyed
-- `d1-platform:<cause>@<first-seen ISO>`, status `watch`. The burst's breadth
-- is recorded here instead of as one row per route: distinct routes/sources the
-- burst touched. NULL on every other row. Additive; a no-op on an empty database.
ALTER TABLE fault_signatures ADD COLUMN incident_routes INTEGER;
ALTER TABLE fault_signatures ADD COLUMN incident_sources INTEGER;

-- Backfill (OPE-1665 ask 4, "leave them watch and stop new per-statement
-- rows"): the per-statement rows of a platform cause that are still `proposed`
-- and unfiled are ruled `watch` like the 2,457 overload rows John ruled on
-- 2026-11-17. Pre-flight on prod 2026-11-17 ~14:35Z: 31 rows (17 network-lost,
-- 14 cpu-reset; 0 overloaded, 0 storage-timeout). `inherited_from='platform'`
-- marks them as machine-ruled, which is also the rollback key:
--   UPDATE fault_signatures SET status='proposed', inherited_from=NULL
--    WHERE inherited_from='platform' AND signature NOT LIKE 'd1-platform:%';
-- Rows carrying an ope_id, and every non-`proposed` status, are untouched.
-- Idempotent; a no-op on an empty database.
UPDATE fault_signatures
   SET status = 'watch', inherited_from = 'platform'
 WHERE status = 'proposed'
   AND ope_id IS NULL
   AND (   error_class LIKE '%d1 db is overloaded%'
        OR error_class LIKE '%d1 db exceeded its cpu time limit%'
        OR error_class LIKE '%d1_error: network connection lost%'
        OR error_class LIKE '%storage operation exceeded timeout%');

-- OPE-613 scope 2 — re-scope two `noise` rulings that were made about one fault
-- and were silently suppressing another.
--
-- `fault_signatures.error_class` stripped the quoted property from client
-- TypeErrors, so these three real and unrelated messages
--
--   TypeError: null is not an object (evaluating 'b.parentNode')
--   TypeError: null is not an object (evaluating 'o.id')
--   TypeError: null is not an object (evaluating 's.id')
--
-- all normalized to the identical class `typeerror: null is not an object
-- (evaluating )`. Two rows sit at status='noise' under that class:
--
--   /events/salem-haunted-happenings-grand-parade/2026   count 168
--   /events/cummington-fair/2026                         count  22
--
-- Both were ruled noise on 2026-07-17 on evidence specific to `b.parentNode` —
-- minified third-party DOM code, a 3-second iPhone Safari loop-burst, 0
-- recurrence in 12 days. A DIFFERENT token entirely from `.id`.
--
-- So an `.id` fault landing on either route deduped into a human's ruling about
-- a fault it has nothing to do with, and was never seen again. One shape's
-- adjudication was retiring a shape that has never been adjudicated at all.
--
-- The code change in this PR makes `normalizeErrorClass` emit
-- `typeerror: null is not an object (evaluating *.parentnode)` and
-- `… (evaluating *.id)` as distinct classes. This migration re-keys the two
-- existing rulings onto the `*.parentnode` class so the decision that was
-- actually made continues to apply to the fault it was actually made about —
-- and `.id` is free to propose on its own evidence.
--
-- Deliberately NOT deleting the rows. The ruling is real and re-litigating it
-- would waste a triage slot on a fault a human already closed with evidence.
--
-- Idempotent: re-running matches nothing, because the rows no longer carry the
-- old class. No-op on an empty database — a bare UPDATE with no FK dependency,
-- so a fresh CI-built D1 applies it without an abort.

UPDATE fault_signatures
   SET error_class = 'typeerror: null is not an object (evaluating *.parentnode)',
       signature   = replace(
                       signature,
                       'typeerror: null is not an object (evaluating )',
                       'typeerror: null is not an object (evaluating *.parentnode)')
 WHERE error_class = 'typeerror: null is not an object (evaluating )'
   AND status = 'noise';

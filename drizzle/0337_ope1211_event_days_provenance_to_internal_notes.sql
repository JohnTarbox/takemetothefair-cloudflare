-- OPE-1211 — move machine provenance out of the PUBLIC day note.
--
-- `event_days.notes` renders verbatim on the public event page. 765 rows held
-- nothing but a June batch-backfill provenance string there, with
-- `internal_notes` (drizzle/0240) empty on every one. This moves each string to
-- `internal_notes` and clears `notes`.
--
-- Matched on the EXACT nine values measured in prod on 2026-09-28 (765 rows:
-- 369 + 156 + 145 + 40 + 15 + 14 + 12 + 10 + 4), not on prefixes, so a row
-- carrying any other text — the ~47 mixed prose-plus-source rows that stay
-- with OPE-572 — cannot be touched.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer — one statement, applied once by the deploy's migrate step.
--   idempotent    — a moved row has notes NULL and internal_notes set, so it no
--                   longer matches either guard; a re-run changes 0 rows. No-op
--                   on an empty (CI) database.
--   read-back     — expect 765 changed; afterwards 0 rows hold these values in
--                   `notes`.
--   rollback      — UPDATE event_days SET notes = internal_notes,
--                   internal_notes = NULL WHERE notes IS NULL AND
--                   internal_notes IN (<the same nine values>);
UPDATE event_days
SET internal_notes = notes,
    notes = NULL
WHERE notes IN (
    'backfilled from description (UX-R1 Wave 2, 2026-06-03)',
    'auto-weekly-backfill 2026-06-21',
    'backfilled from description (UX-R1, 2026-06-02)',
    'backfilled by cadence-expander 2026-06-13 (src: description)',
    'backfilled by cadence-expander 2026-06-13 (src: granitetheatre.org)',
    'backfilled by cadence-expander 2026-06-13 (src: capecodchambermusic.org)',
    'backfilled by cadence-expander 2026-06-13 (src: makefoodyourbusiness.org)',
    'corrected by verification 2026-06-13 (src: downtownworcester.org)',
    'backfilled by cadence-expander 2026-06-13 (src: name-cadence)'
  )
  AND (internal_notes IS NULL OR internal_notes = '');

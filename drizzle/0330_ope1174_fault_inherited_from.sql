-- OPE-1174 — mark a fault_signatures row whose status was INHERITED rather
-- than ruled. Set to 'class' when the emitter mints a new route's row as
-- `noise` because its error class was already ruled noise on >= 3 other routes
-- and never ruled a real fault (src/lib/faults/reconcile.ts). NULL on every
-- existing row: those rulings were made by a person, and the column exists so
-- a reviewer can tell the two apart. Additive; a no-op on an empty database.
ALTER TABLE fault_signatures ADD COLUMN inherited_from TEXT;

-- OPE-1481 (a), approved by John 2026-10-17: two short PUBLIC visitor-copy
-- columns on events only, for what the ORGANIZER publishes about parking and
-- accessibility at this event.
--   NULL      = not published / nobody has looked (renders as absent)
--   non-NULL  = the organizer's own statement, ≤300 chars. MCP writers refuse a
--               value without an event_data_citations row (field_name
--               'parking_notes' / 'accessibility_notes') carrying the source
--               URL and a VERBATIM excerpt — the pet_friendly rule (OPE-1061).
-- Deliberately NOT access_notes (admission copy, OPE-1151) and NOT a wider
-- visitor-policies family (OPE-852). No backfill: nullable ADD COLUMNs only.
ALTER TABLE events ADD COLUMN parking_notes TEXT;
ALTER TABLE events ADD COLUMN accessibility_notes TEXT;

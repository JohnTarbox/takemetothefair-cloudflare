-- OPE-463 — seed the inbound → event link probe, ARMED.
--
-- CLAUDE.md (OPE-246): a new writer ships WITH its probe. submitEvent now writes
-- one `inbound_email_events` row per event an inbound email creates. The table
-- shipped in #1187 and stayed EMPTY for 17 days with nothing noticing — which
-- is exactly the silence this probe exists to report.
--
-- WINDOW 21 days: the `inbound-submit` probe's window, same lane, same inflow
-- (~4 event-creating emails/week).
--
-- No-op on an empty database: no foreign keys, ON CONFLICT DO NOTHING.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'inbound-email-event-links',
  unixepoch(),
  'OPE-463 - watches inbound_email_events.created_at, written by submitEvent (mcp-server email-handlers/submit.ts) once per event an inbound email creates. The table sat empty 17 days after it shipped because no writer existed. Window 21d = the inbound-submit probe window (same lane and inflow).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

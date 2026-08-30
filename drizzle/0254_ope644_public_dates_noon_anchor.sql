-- OPE-644 — shift midnight-anchored public_start_date / public_end_date to noon UTC.
--
-- These two columns SHADOW start_date/end_date on the public event page
-- (`event.publicStartDate ?? event.startDate`), and date-only rendering is
-- Eastern. Midnight UTC is 20:00 the PREVIOUS day in Eastern, so a
-- midnight-anchored row renders the served date band one day early at BOTH ends
-- — while the "Dates:" list on the same page, which reads event_days directly,
-- stays correct. The page contradicted itself, and the header was the wrong half.
--
-- Measured on prod 2026-08-30 before this ran:
--
--   events with public dates          668
--   public_start_date at midnight UTC  39
--   public_start_date at noon UTC     624   (written after the OPE-482 fix)
--   of the 39, live AND upcoming       17   incl. fairs opening in 5 days
--
-- The calendar DATE in those rows is correct — verified against event_days:
-- date(public_start_date) equals MIN(event_days.date) for every sampled row.
-- Only the time-of-day anchor is wrong, so a +12h shift preserves the intended
-- day exactly. It does NOT recompute from event_days, deliberately: recomputing
-- would silently rewrite dates for rows whose days changed since, which is a
-- different and much larger change than the one this ticket asks for.
--
-- Idempotent: after the shift the value is at 43200, so a second run matches no
-- rows. No-op on an EMPTY database (a WHERE that matches nothing updates
-- nothing), so a fresh CI-built D1 applies it cleanly. No foreign keys touched.
--
-- ⚠️ The writer is fixed in the same PR. `mcp-server/src/helpers.ts` had its own
-- copy of computePublicDates still on `new Date(day + "T00:00:00")` — OPE-482
-- fixed the app's copy and left the Worker's — so a backfill alone would have
-- been re-broken by the next event-day edit made through MCP.
UPDATE events
   SET public_start_date = public_start_date + 43200
 WHERE public_start_date IS NOT NULL
   AND public_start_date % 86400 = 0;

UPDATE events
   SET public_end_date = public_end_date + 43200
 WHERE public_end_date IS NOT NULL
   AND public_end_date % 86400 = 0;

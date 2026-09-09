-- OPE-865 — split the newsletter-broadcast probe by audience.
--
-- The old `newsletter-broadcast` probe queried `newsletter_issues.sent_at` with
-- NO audience filter, so one control covered two independent newsletters. The
-- weekend digest sends far more often than its 21-day window, which meant the
-- vendor digest could be silent indefinitely without the probe ever going
-- stale — the vendor list going dark being exactly the failure it read as
-- covering. The accidental vendor broadcast of 2026-09-09 then stamped
-- `sent_at` and refreshed the probe for BOTH audiences, so the incident
-- cleared the only signal that might have reported it.
--
-- It was never inert: it ran, and it would have fired if BOTH newsletters
-- died. It simply could not distinguish the case anyone cares about.
--
-- `newsletter-broadcast-weekend` inherits the old probe's arming — it is what
-- the original actually measured in practice, and it is correct today.
--
-- ⚠️ `newsletter-broadcast-vendor` is seeded DORMANT (`enabled_at` NULL) ON
-- PURPOSE. Two independent reasons:
--
--   1. Under the PARKED OPE-710(a) ruling, Path A — the only thing that stamps
--      sent_at for the vendor audience — is SUPPOSED to be silent. An armed
--      probe would be a permanent false positive: the naive canary OPE-855
--      item H proposed and then explicitly withdrew.
--   2. Path B, the rail that actually sends today, writes no newsletter_issues
--      row at all while it rides send_test_email. There is no evidence stream,
--      so no window can be measured, and a guessed one repeats the OPE-830
--      analogy error (72h chosen by analogy against a real 12-day gap).
--
-- ARMING CONDITION (do not lose this — a dormant probe nobody arms is the
-- OPE-6 v3.8 failure wearing a different hat):
--   1. OPE-610 §4 lands: Path B writes a real newsletter_issues row with
--      audience='vendor'.
--   2. Measure the real cadence from those rows. OPE-855 item H observed
--      Mondays 11:18-14:09Z with one 23:59Z outlier — a starting point, not
--      the answer.
--   3. Set expectedWindowHours in HEARTBEAT_PROBES from that measurement (the
--      21*24 in the registry is the weekend probe's number copied across as a
--      placeholder, NOT a measurement), THEN set enabled_at.
--
-- ⚠️ For the OPE-752 probe audit: this row is EXPECTED to show a NULL
-- enabled_at. "Every probe has a seed row" still holds — what is deliberately
-- absent is the arming, not the row.
--
-- No-op on an empty database: bare INSERT/UPDATE, no foreign keys, so a fresh
-- CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
SELECT
  'newsletter-broadcast-weekend',
  COALESCE((SELECT enabled_at FROM heartbeat_probes WHERE probe_name = 'newsletter-broadcast'), unixepoch()),
  'OPE-865 - the weekend half of the old un-filtered newsletter-broadcast probe. Watches newsletter_issues.sent_at WHERE audience=weekend. Inherits the original probe arming; 21d window because a real send needs John''s approve click, so a skipped week is normal.',
  unixepoch()
ON CONFLICT(probe_name) DO NOTHING;

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'newsletter-broadcast-vendor',
  NULL,
  'OPE-865 - the vendor half of the old un-filtered newsletter-broadcast probe. Watches newsletter_issues.sent_at WHERE audience=vendor. DORMANT ON PURPOSE: under the parked OPE-710(a) ruling Path A is supposed to be silent, and Path B writes no newsletter_issues row at all while it rides send_test_email - so an armed probe would be a permanent false positive AND there is no evidence stream to measure a window from. ARM IT after OPE-610 s4 lands, by measuring the real vendor send cadence and setting expectedWindowHours from that measurement (the 21*24 in the registry is the weekend number copied across as a placeholder), then setting enabled_at.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

-- Retire the un-filtered predecessor. Left in place it would keep reporting a
-- verdict for a probe name the registry no longer declares, which reads as
-- coverage that does not exist.
DELETE FROM heartbeat_probes WHERE probe_name = 'newsletter-broadcast';

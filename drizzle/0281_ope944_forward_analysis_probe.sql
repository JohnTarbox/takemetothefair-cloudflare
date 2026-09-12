-- OPE-944 — seed the original-sender forward-analysis probe, ARMED.
--
-- CLAUDE.md (OPE-246) requires a new writer path to ship with its probe in the
-- same PR: "Treat the probe as part of the ship, not a follow-up." OPE-944
-- shipped in #1245 without one; this closes that gap.
--
-- WHAT IT WATCHES. `analyzeForward` runs on every inbound email and stamps
-- `inbound_emails.original_sender_auth` on every row — 'not_forwarded' for
-- ordinary mail, 'unverifiable_inline_forward' for an inline forward, or a
-- DKIM verdict when a message was genuinely attached. Evidence is the newest
-- row where that column IS NOT NULL.
--
-- WHY THIS PATH NEEDS A PROBE MORE THAN MOST. The analysis is pure enrichment
-- and fail-soft by design: if it throws, the handler logs a warn and ingestion
-- continues perfectly. Every email still lands, every event is still created,
-- and the ONLY symptom is the column going NULL on new rows. That is the
-- OPE-246 "shipped but silently not executing" class exactly — and OPE-944 is
-- itself an instance of it, since the rfc822 branch it fixes had never once
-- run in the entire archive without anyone noticing.
--
-- ⚠️ EVIDENCE IS THE COLUMN, NOT A RECOVERED .EML — probe the run, never the
-- yield. A probe on "a forwarded message was recovered" would depend on a human
-- choosing Gmail's "Forward as attachment", which had happened ZERO times as of
-- 2026-09-11. It would fire forever, get muted, and cover nothing.
--
-- WINDOW: 72h, MEASURED — 195 inbound rows over 22 days (2026-08-21 → 09-11),
-- median inter-arrival gap 0.03h, p90 9.3h, p99 17.5h, worst observed 18.0h.
-- 72h is 4x the worst real gap. NOT an analogy: a window chosen by analogy is
-- what produced the wrong 72h figure on OPE-830 (real max gap: 12 days).
--
-- ARMED, not dormant. The two documented dormant cases are a flag-gated path
-- and an unmeasurable window; this is neither. Pre-OPE-944 rows are NULL, so
-- first evidence is the first mail after deploy — inside 18h per the measurement.
--
-- No-op on an empty database: a bare INSERT with ON CONFLICT DO NOTHING and no
-- foreign keys, so a fresh CI-built D1 applies it without an FK abort.

INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'inbound-forward-analysis',
  unixepoch(),
  'OPE-944 - watches inbound_emails.original_sender_auth, written by analyzeForward in the email handler on EVERY inbound message (not_forwarded / unverifiable_inline_forward / a DKIM verdict). Guards a fail-soft enrichment path whose only failure symptom is the column going NULL on fresh mail, while ingestion continues looking perfectly healthy. Probes the RUN, not the yield: a probe keyed on an .eml actually being recovered would depend on a human choosing Forward-as-attachment, which had occurred zero times as of 2026-09-11, so it would fire forever and get muted. Window 72h = 4x the worst observed inter-arrival gap (18.0h; 195 rows over 22 days, median 0.03h, p99 17.5h).',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

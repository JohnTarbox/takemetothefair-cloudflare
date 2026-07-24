-- OPE-284 — first-evidence probe for the newsletter broadcast path.
--
-- Ships WITH the flag flip (NEWSLETTER_SEND_ENABLED "false" -> "true"), per the
-- OPE-246 rule that a newly-armed execution path declares the D1 evidence it
-- should keep producing.
--
-- Evidence is `newsletter_issues.sent_at`, not the send ledger: a test_recipient
-- preview writes ledger rows under the same `newsletter:weekly-digest` source,
-- so a ledger-keyed probe would read green on a preview to John while the
-- subscriber list received nothing. `sent_at` is stamped only by a real
-- broadcast.
--
-- enabled_at is the ship date (the flag is ON as of this migration, not gated
-- behind a later flip), so the probe is live immediately. The 21-day window in
-- HEARTBEAT_PROBES tolerates a skipped week — a real send requires John's
-- approve click — while still catching a silently-dead flow.
--
-- Note: this path is NOT new. A real broadcast already went out 2026-07-16 to
-- all 6 confirmed subscribers; the flag then silently reverted to "false" when a
-- deploy re-applied wrangler.toml over a dashboard-set var, and the 07-23
-- approve click failed. That regression is precisely what this probe watches for.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'newsletter-broadcast',
  strftime('%s', '2026-07-24'),
  'OPE-284 newsletter go-live — a real broadcast stamps newsletter_issues.sent_at (test sends never do)',
  unixepoch()
)
ON CONFLICT (probe_name) DO NOTHING;

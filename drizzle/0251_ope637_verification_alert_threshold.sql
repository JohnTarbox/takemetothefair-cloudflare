-- OPE-637 — seed `verification_alert_threshold_hours` at 48.
--
-- John's 2026-08-14 constraints for OPE-177 scope 3 required this to be a
-- STORED parameter ("No magic 24/48 baked into code") seeded at 48h. What
-- shipped was `const GRACE_H = 24` inside unconfirmedAuthEmailFlow — the exact
-- constant the instruction ruled out, at half the specified seed — and no
-- comment recorded the constraint as built, dropped or renegotiated.
--
-- The window decides QUEUE MEMBERSHIP: at 24h the queue stood at depth 13, and
-- nobody could change that without a deploy.
--
-- Idempotent via NOT EXISTS: re-running inserts nothing, and — importantly — a
-- value an operator has since tuned is never stamped back to 48. Safe on an
-- empty database: `tunable_thresholds` is created by an earlier migration and
-- the INSERT is guarded, so a fresh CI D1 built from migrations just gets the
-- seed row.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
SELECT
  'verification_alert_threshold_hours',
  48,
  'hours',
  'How long a DELIVERED verification email is given before the signup counts as stuck in the unconfirmed_auth_email queue. Seeded 48 per OPE-177 scope 3 (2026-08-14). Self-tuned to the p95 of observed email_verified-created_at for real registrations, clamped to [12,168] — see src/lib/verification-threshold.ts. Raising it shrinks the queue and delays noticing a real drop-off problem; lowering it fills the queue with people who only just signed up. This is a SIGNAL, not a verdict: delivery events cannot see inbox placement, so "delivered and unconfirmed" is a ceiling on drop-off.',
  CAST(strftime('%s','now') AS INTEGER)
WHERE NOT EXISTS (
  SELECT 1 FROM tunable_thresholds WHERE key = 'verification_alert_threshold_hours'
);

-- 2026-05-18: idempotency marker for "your submission was approved" emails.
--
-- The notification hook fires on PENDING/TENTATIVE → APPROVED transitions
-- for events whose suggester_email is populated (community form, vendor
-- form, or email-pipeline submissions). It pushes one EMAIL_JOBS message
-- and sets this column to the send time so subsequent admin edits (e.g.,
-- admin un-approves then re-approves to fix a typo) don't re-notify.
--
-- NULL = never notified. NOT NULL = notified at the recorded timestamp.
-- No backfill: any historical event that's already APPROVED and has a
-- suggester_email won't trigger a notification on its next edit (this is
-- intentional — we don't want to send "your event was approved" emails
-- for submissions made months/years ago).

ALTER TABLE events ADD COLUMN approval_notified_at INTEGER;

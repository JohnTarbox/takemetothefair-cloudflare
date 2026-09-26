-- OPE-1163 — thread-reply-ack is withheld when a person here replied to the
-- same thread or recipient within this many hours. Tunable without a deploy.
-- Measured 2026-09-25: 15 of 22 thread acks went out within 24h of a
-- reply:manual; the ticket's suggested starting value is 72h.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'thread_ack_quiet_after_human_hours',
  72,
  'hours',
  'OPE-1163 — no thread-reply-ack if a reply:manual* went to this thread or recipient within this many hours before the message arrived. The operator owed-human notice still goes.',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

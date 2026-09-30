-- OPE-1148 — machine mail is held, never acked, never turned into an event.
--
-- 1. inbound_emails.automation_headers: JSON of the automation headers present
--    on each message (Auto-Submitted, Precedence, List-Id, List-Unsubscribe,
--    X-Forwarded-For/-To). None of them was stored before, which is why the
--    header rules' false-positive rate could not be measured when they were
--    chosen. ADD COLUMN only — no rebuild, and inbound_emails is a parent table.
ALTER TABLE inbound_emails ADD COLUMN automation_headers TEXT;

-- 2. Burst-breaker thresholds, tunable without a deploy. Measured 2026-09-24:
--    in 120 days submit@ never saw more than 2 distinct senders in an hour
--    (117 hours at 1, one at 2); the 2026-09-23 forwarded-inbox hour had 6.
--    Trips only when BOTH limits are exceeded, so one person sending a dozen
--    forwards in an hour never trips it.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'inbound_burst_window_minutes',
  60,
  'minutes',
  'OPE-1148 — sliding window for the inbound burst breaker (per receiving address).',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'inbound_burst_max_messages',
  6,
  'messages',
  'OPE-1148 — burst trips when a receiving address gets MORE than this many messages in the window AND more than inbound_burst_max_senders distinct senders. Held messages stay salvageable.',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'inbound_burst_max_senders',
  4,
  'senders',
  'OPE-1148 — distinct-sender limit for the burst breaker. Observed peak outside the 2026-09-23 incident: 2 per hour over 120 days.',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

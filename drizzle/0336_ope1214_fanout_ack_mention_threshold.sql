-- OPE-1214 — a fan-out sibling intent is NAMED in the leader's ack
-- ("we also read it as …") only at or above this classifier confidence.
-- Below it the sibling row is still created and routed; the ack is silent
-- about it. Measured 2026-09-28: only 6 fan-out children exist (claim_request
-- 0.88/0.90/0.95, correction 0.92/0.95, new_event 0.98) — too few to derive a
-- value. 0.95 sits above the specimen's wrong 0.90 "request to claim a
-- listing". Tunable without a deploy.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'fanout_ack_mention_min_confidence',
  0.95,
  'confidence',
  'OPE-1214 — minimum classifier confidence for a sibling intent to be named in the fan-out leader''s ack. Below it the sibling is routed silently.',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

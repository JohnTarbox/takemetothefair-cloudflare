-- OPE-368 (R4) — give the EMAIL_REPLY_ENABLED gate a voice, a memory, and a
-- request path.
--
-- Today a refused reply returns `disabled:true` and writes nothing. The prose
-- an agent composed for a waiting customer is discarded on the spot; the fact
-- that someone tried is invisible to the fault ledger, the canaries and the
-- Monday inventory. It surfaced on 2026-08-10 only because a human happened to
-- be in the loop when it happened.
--
-- The configuration is also inverted: the auto-ack promising "our team will get
-- back to you soon" is NOT gated and fires in six seconds, while the reply that
-- would keep that promise IS gated. The system can promise anything and deliver
-- nothing, silently. This table is where the undelivered half now goes, so the
-- promise has somewhere to be kept from.
--
-- The one prior free-form reply in the whole ledger is `reply:manual-gmail`
-- (n=1, 2026-07-12) — someone answering from Gmail because the sanctioned path
-- was closed. Replying off-ledger was not a bad habit; it was the only path the
-- system left open. This gives the sanctioned path a waiting room instead.
CREATE TABLE IF NOT EXISTS pending_email_replies (
  id TEXT PRIMARY KEY,
  -- The inbound this answers. Not a hard FK: an inbound row can be pruned, and
  -- losing the draft with it would defeat the purpose.
  inbound_email_id TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  -- Who composed it: an agent code, or an admin user id. So "which lane keeps
  -- hitting this wall" is answerable.
  requested_by TEXT,
  requested_at INTEGER NOT NULL,
  -- pending → approved | discarded | sent
  --
  -- `approved` is deliberately NOT `sent`. An admin approving a draft records
  -- the human decision; the actual delivery still respects EMAIL_REPLY_ENABLED,
  -- because routing around an operator's stop-gate from inside the feature the
  -- gate exists to stop would be the wrong lesson to encode. Approved drafts
  -- go out the moment John flips the flag, and not before.
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT,
  -- Set once delivery actually happens, linking to email_send_ledger.
  sent_message_id TEXT
);

-- The operator's working view: "what is waiting on me", oldest first.
CREATE INDEX IF NOT EXISTS idx_pending_email_replies_status
  ON pending_email_replies(status, requested_at);

-- "Has anyone already drafted a reply to this email?" — asked per inbound.
CREATE INDEX IF NOT EXISTS idx_pending_email_replies_inbound
  ON pending_email_replies(inbound_email_id);

-- submission_correction_tokens — single-use tokens backing the B4
-- pre-filled correction form sent in MEDIUM/LOW confidence email replies.
--
-- Flow:
--   1. Workflow issues a token when sending an ok-medium / ok-low reply,
--      bound to the PENDING event that was just created. The token URL
--      is embedded in the reply email's template.
--   2. Sender clicks the link → GET /submit-event/<token> renders an
--      edit form pre-filled with the event's current (low-confidence)
--      values.
--   3. Sender corrects + submits → POST /api/submit-event/<token>
--      validates, updates the event row, marks token used_at.
--   4. Token is one-time: subsequent GETs/POSTs to a used token see
--      a "this link has been used" message and link to the live event
--      page (if approved) or a contact-us message (if still pending).
--
-- expires_at: 30 days from issuance. Long enough that a sender opening
-- an old email won't be annoyed; short enough that abandoned tokens
-- don't accumulate forever.

CREATE TABLE submission_correction_tokens (
  token TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  -- inbound_emails row that produced this token. Useful for the admin
  -- UI to show "this event was corrected via inbound 2f5f0c74".
  inbound_email_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Reverse lookup: "show me all correction-tokens for event X" (admin
-- detail view, "this event has 1 outstanding correction link" badge).
CREATE INDEX idx_submission_correction_tokens_event
  ON submission_correction_tokens (event_id);

-- Sweep query: "find expired-and-unused tokens for cleanup". The
-- partial-WHERE makes this a tiny tip-of-the-index that the sweep
-- can iterate cheaply.
CREATE INDEX idx_submission_correction_tokens_expires
  ON submission_correction_tokens (expires_at)
  WHERE used_at IS NULL;

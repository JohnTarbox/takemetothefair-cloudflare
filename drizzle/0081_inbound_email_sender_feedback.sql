-- 2026-05-20 (Phase D.3): Sender feedback widgets — signed-token tables.
-- Two tables:
--   inbound_email_feedback_tokens — lifecycle table for the random
--     32-byte tokens we embed in outbound email links (receipt +
--     approval-notification). Token is the PK. Used to enforce
--     one-time-use and 60-day expiry.
--   inbound_email_sender_feedback — the actual feedback events
--     captured when a token is consumed. Per-token row keyed by
--     feedback_token UNIQUE.
--
-- Token mechanism (spec §D.3.2 — adapted to codebase convention):
--   The spec calls for HMAC(secret, ...). We use the codebase pattern
--   instead: 32 random bytes from crypto.getRandomValues, base64url-
--   encoded, INSERTed into the tokens table. Equivalent security
--   (DB-backed lookup vs HMAC verification), simpler revocation, no
--   shared secret to rotate. Matches src/lib/vendor-claim-token.ts:26-85.
--
-- Scanner-click handling (spec §D.3.5 / §Q8):
--   The /feedback/[token] endpoint detects known link-scanner UAs
--   (Microsoft Safe Links, Mimecast, Proofpoint, etc.) and consumes
--   the token (marks used_at) WITHOUT writing a sender_feedback row.
--   This prevents scanner pre-clicks from polluting the dataset.
--   The scanner UA list lives in mcp-server/src/intent-fastpath.ts
--   (KNOWN_SCANNER_UA_PATTERNS) — shared with the entrypoint module.

CREATE TABLE inbound_email_feedback_tokens (
  token TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  -- 'receipt' (post-submit auto-reply buttons) | 'approval' (post-
  -- approval-notification buttons) | 'other' (future use).
  feedback_moment TEXT NOT NULL,
  -- The event this feedback is about, when applicable. Null for
  -- receipt-moment tokens on submit-intent rows before the event has
  -- been created, AND for non-event-related intents.
  resulting_event_id TEXT,
  issued_at INTEGER NOT NULL,
  -- 60-day expiry (configurable in src/lib/feedback-tokens.ts).
  expires_at INTEGER NOT NULL,
  -- One-time-use marker. NULL → unused. Set to unixepoch on first
  -- consume (real user click OR scanner pre-click). Idempotent —
  -- second click reads the row, sees used_at set, returns "already
  -- recorded" UX.
  used_at INTEGER,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (resulting_event_id) REFERENCES events(id)
);

CREATE INDEX idx_feedback_tokens_email ON inbound_email_feedback_tokens(inbound_email_id);
CREATE INDEX idx_feedback_tokens_event
  ON inbound_email_feedback_tokens(resulting_event_id)
  WHERE resulting_event_id IS NOT NULL;
-- Expiry sweep candidate (future) — not used by any current code path
-- but cheap to maintain and useful for the cleanup job.
CREATE INDEX idx_feedback_tokens_expires ON inbound_email_feedback_tokens(expires_at);

CREATE TABLE inbound_email_sender_feedback (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  -- The exact token that was clicked. UNIQUE so we don't double-count
  -- the same click (the endpoint also enforces one-time-use via
  -- inbound_email_feedback_tokens.used_at, but this is belt-and-
  -- suspenders for the case where two requests race against the same
  -- token).
  feedback_token TEXT NOT NULL UNIQUE,
  -- 'receipt' | 'approval' | 'other'. Same enum as
  -- inbound_email_feedback_tokens.feedback_moment.
  feedback_moment TEXT NOT NULL,
  -- 'correct' | 'wrong_intent' | 'needs_fixing' | 'cancel' |
  -- 'looks_good'. See spec §D.3.4 for semantics. Note 'cancel' is
  -- destructive (cancels the PENDING event); the endpoint applies
  -- it inline before recording the feedback row.
  feedback_value TEXT NOT NULL,
  -- When feedback_value='wrong_intent', the sender's intended intent
  -- (from the follow-up form). Joins with classifier feedback in the
  -- D.4 dashboard.
  intended_intent TEXT,
  -- Optional free-text reason from the follow-up form.
  free_text TEXT,
  -- The event this feedback is about, when applicable.
  resulting_event_id TEXT,
  submitted_at INTEGER NOT NULL,
  -- Abuse-detection only — never shared outside admin queries.
  submitter_ip TEXT,
  submitter_user_agent TEXT,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id),
  FOREIGN KEY (resulting_event_id) REFERENCES events(id)
);

CREATE INDEX idx_sender_feedback_email
  ON inbound_email_sender_feedback(inbound_email_id);
-- D.4 dashboard groups by (moment, value).
CREATE INDEX idx_sender_feedback_moment
  ON inbound_email_sender_feedback(feedback_moment, feedback_value);

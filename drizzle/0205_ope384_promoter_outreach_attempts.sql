-- OPE-384 stage 1 — the record behind asking an organizer to confirm their own event.
--
-- Today there is no first-class way to email a promoter. On 2026-08-13 a human
-- hand-sent one from `hello@` for Dartmouth Grange Fair 2026, and when the reply
-- arrives nothing will link it back to "this was our date-confirmation ask for
-- event X." This table is that link.
--
-- Mirrors `vendor_outreach_attempts` in spirit, and departs from it in three
-- places that the vendor table's own gaps argue for:
--
-- 1. **The message is stored, not just its status.** `vendor_outreach_attempts`
--    keeps an outcome and a free-text note; it cannot answer "what did we
--    actually ask them?" For a confirmation loop that question IS the record —
--    a reply is only interpretable against the ask that produced it.
--
-- 2. **`to_address` is stored as sent.** `promoters.contact_email` will change;
--    history must keep saying who we really wrote to, not who we would write to
--    today.
--
-- 3. **`queued` is a first-class status, not a failure.** OPE-368's lesson: a
--    send refused by an enablement gate must be RECOVERABLE, not discarded at
--    the moment of refusal. The row is written before the send, so gated prose
--    survives and becomes drainable the day the flag flips.
--
-- The status vocabulary is the ticket's, plus `queued` and `refused`:
--   queued      — written, not yet sent (gate off, or awaiting approval)
--   sent        — handed to the transactional pipeline
--   replied     — an inbound was linked back to it
--   confirmed   — the reply actually resolved the question and the event was updated
--   no_response — the timeout elapsed; eligible for exactly one follow-up
--   bounced     — dead address; belongs back in promoter-enrichment
--   refused     — a human discarded the draft
--
-- `replied` and `confirmed` are deliberately separate. An organizer who writes
-- back "let me check with the committee" has replied and confirmed nothing, and
-- collapsing the two would score that as a closed loop.

CREATE TABLE IF NOT EXISTS promoter_outreach_attempts (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  -- Nullable: an ask can be about the organizer generally (missing contact,
  -- claim follow-up) rather than about one event.
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  -- Why this event was flagged (stage 2 fills this from the trigger queue).
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  outcome_at INTEGER,
  -- The inbound that closed it (stage 4).
  inbound_email_id TEXT,
  -- Provider message id, so the ledger and RFC 5322 threading can be joined.
  provider_message_id TEXT,
  -- The attempt this one follows up on. Self-referencing, so "capped at one
  -- follow-up" is checkable by walking a chain of length <= 1.
  follow_up_of TEXT REFERENCES promoter_outreach_attempts(id)
);

CREATE INDEX IF NOT EXISTS idx_promoter_outreach_promoter
  ON promoter_outreach_attempts(promoter_id);
CREATE INDEX IF NOT EXISTS idx_promoter_outreach_status
  ON promoter_outreach_attempts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_promoter_outreach_event
  ON promoter_outreach_attempts(event_id);

-- "Never double-ask" as a DATABASE invariant, not a query convention.
--
-- The ticket asks that an open attempt suppress re-flagging. Enforcing that
-- only in the caller is how OPE-423 happened: an invariant that lives in one
-- code path is violated by the second code path, twenty-four days later, with
-- nothing to stop it. A partial unique index makes a second open ask for the
-- same event impossible regardless of who writes it.
--
-- Scoped to the OPEN statuses, so the closed history of an event can hold as
-- many past attempts as it accumulated — and so the single capped follow-up
-- (created only after the first goes `no_response`) is still permitted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promoter_outreach_one_open_per_event
  ON promoter_outreach_attempts(event_id)
  WHERE event_id IS NOT NULL AND status IN ('queued', 'sent');

-- OPE-246 — the probe ships WITH the writer, like a migration.
--
-- DORMANT: `enabled_at` is NULL because `PROMOTER_OUTREACH_ENABLED` is "false"
-- until John approves the organizer-facing copy. A probe that fired while the
-- capability was deliberately switched off would be pure noise, and noise is
-- how a real silence gets ignored. Set `enabled_at` the day the flag flips.
--
-- It watches `created_at`, not `sent_at`: the attempt row is written BEFORE the
-- send and survives a gated refusal, so this asks "is the rail being exercised
-- at all", which is what distinguishes a dead rail from a paused one.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'promoter-outreach-attempts',
  NULL,
  'OPE-384 stage 1 — dormant until PROMOTER_OUTREACH_ENABLED flips; watches promoter_outreach_attempts.created_at',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

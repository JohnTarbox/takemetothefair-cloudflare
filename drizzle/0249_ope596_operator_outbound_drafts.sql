-- OPE-596 — operator-INITIATED outbound drafts, in their own table.
--
-- Build authorized by John on the issue, 2026-08-28, with an explicit
-- guardrail: "build it with OPERATOR_OUTBOUND_ENABLED defaulting OFF. The flip
-- to actually enable sending is John's, made when he's ready — the build going
-- in does not by itself put mail in front of anyone."
--
-- ── Why not reuse `pending_email_replies` (his item 3) ────────────────────
-- That table's `inbound_email_id` is NOT NULL, and the coupling is load-bearing:
-- every row in it answers "which submission is this a reply to", and the review
-- tools, the threading headers and the ledger join all lean on it. Operator-
-- initiated mail has no inbound, so reusing the table would mean dropping that
-- NOT NULL — weakening a constraint that is doing real work, for a row shape
-- that shares only its status machine.
--
-- ── Properties ────────────────────────────────────────────────────────────
-- Pure DDL, additive, no data touched. `IF NOT EXISTS` throughout, so it is
-- idempotent and a no-op on re-run. Trivially a no-op on an empty database,
-- which is what CI applies every migration to.
--
-- Nothing here can send anything. This is a drafts table; delivery is gated in
-- code behind OPERATOR_OUTBOUND_ENABLED, which ships off.
CREATE TABLE IF NOT EXISTS operator_outbound_drafts (
  id                  TEXT PRIMARY KEY,
  to_address          TEXT NOT NULL,
  subject             TEXT NOT NULL,
  body_text           TEXT NOT NULL,
  -- Why this is being sent, in the composer's own words. A draft with no
  -- stated purpose is one nobody can approve responsibly.
  reason              TEXT NOT NULL,
  related_entity_type TEXT,
  related_entity_id   TEXT,
  composed_by         TEXT,
  composed_at         INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  reviewed_by         TEXT,
  reviewed_at         INTEGER,
  review_note         TEXT,
  sent_at             INTEGER,
  sent_message_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_outbound_status
  ON operator_outbound_drafts (status, composed_at);

CREATE INDEX IF NOT EXISTS idx_operator_outbound_entity
  ON operator_outbound_drafts (related_entity_type, related_entity_id);

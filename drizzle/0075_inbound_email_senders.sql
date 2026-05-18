-- 2026-05-18: Admin annotation table for inbound email senders.
-- Keyed by email address (lowercased). Holds operator-set trust status
-- and free-form notes so the admin queue can mark known-good submitters
-- separately from watchlist/blocked addresses, and so the sender-quality
-- summary on /admin/inbound-emails can surface annotation alongside the
-- derived metrics (volume, approved%, dedup-hit rate, etc.).
--
-- This table does NOT replicate inbound_emails data. It's purely the
-- admin's editorial layer; counts and outcomes are still computed by
-- aggregating inbound_emails + events at query time.
--
-- trust_status semantics:
--   'unknown'   — default for senders we haven't reviewed yet. Same
--                 treatment as today (rate limits, gates, etc.).
--   'trusted'   — known legitimate submitter; future hook point for
--                 e.g. fast-tracking PENDING → APPROVED on Tier 1
--                 sources. Not wired to any code path yet.
--   'watchlist' — suspect quality; surfaced in admin queue with flag.
--                 Not wired to any code path yet.
--   'blocked'   — drop on receipt. Future hook point for the email
--                 entrypoint to short-circuit before workflow create.
--                 Not wired yet — the entrypoint still processes
--                 these messages identically until that wiring lands.
--
-- All status values land in the table via either admin UI (TBD) or
-- the set_email_sender_trust MCP tool.

CREATE TABLE inbound_email_senders (
  email TEXT PRIMARY KEY,
  trust_status TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX idx_inbound_senders_trust ON inbound_email_senders(trust_status);

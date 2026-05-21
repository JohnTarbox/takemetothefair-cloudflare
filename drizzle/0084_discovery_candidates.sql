-- discovery_candidates — registry of source domains we know about.
--
-- Backs the 3-tier source_suggestion handler (spec §C.8). When a sender
-- emails us pointing at a website as a potential events source, the
-- handler does:
--
--   Tier 1: SELECT FROM discovery_candidates WHERE host=? AND status='active'
--           → "we already pull from this source" reply.
--   Tier 2: events.source_url LIKE '%host%' check (informal usage)
--           → "we already use this source, admin will formally register"
--   Tier 3: INSERT a new row with status='pending_review'
--           → "thanks, queued for review" reply.
--
-- status lifecycle:
--   pending_review (default) — submitter just emailed; admin hasn't seen yet
--   active                   — admin approved; treat as an active source
--   rejected                 — admin reviewed and declined (e.g. paywall,
--                              irrelevant domain, etc.)
--
-- Admin actions on the row go through /admin/discovery-candidates which
-- writes admin_actions audit rows with action='discovery_candidate.approve'
-- or 'discovery_candidate.reject'.

CREATE TABLE discovery_candidates (
  id TEXT PRIMARY KEY,
  -- Full URL of the suggested source as submitted (some senders point at
  -- specific /events/ pages, others at the root). host is the canonical
  -- lookup key for Tier 1 matching.
  url TEXT NOT NULL,
  -- Lowercased hostname stripped of `www.` prefix, e.g. "mainemade.com".
  -- The Tier 1 lookup is on this column.
  host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review',
  -- Email address of the sender who suggested it (denormalized from the
  -- inbound row at insert time for cheap admin queries).
  suggested_by_email TEXT,
  -- inbound_emails.id that triggered this row. NULL if admin entered it
  -- manually (not part of this PR but reserved for the admin UI flow).
  suggested_via_inbound_id TEXT,
  -- Audit fields. reviewed_at + reviewed_by_user_id stay NULL until admin
  -- transitions status off pending_review.
  reviewed_at INTEGER,
  reviewed_by_user_id TEXT,
  admin_notes TEXT,
  created_at INTEGER NOT NULL
);

-- Primary lookup index: Tier 1 query.
CREATE INDEX idx_discovery_candidates_host ON discovery_candidates (host);
-- Admin queue: status='pending_review' filter.
CREATE INDEX idx_discovery_candidates_status ON discovery_candidates (status);
-- One pending suggestion per host — multiple senders flagging the same
-- domain pile into one row rather than spawning a queue of duplicates.
-- Partial unique: only enforces uniqueness on pending_review rows; an
-- old rejected row + a fresh pending row for the same host is allowed
-- (the rejection might have aged out of admin's memory).
CREATE UNIQUE INDEX uq_discovery_candidates_pending_host
  ON discovery_candidates (host)
  WHERE status = 'pending_review';

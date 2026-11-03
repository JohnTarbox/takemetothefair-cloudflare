-- OPE-1139 — staging for exhibitors who announce THEMSELVES ("visit us at Booth
-- 510") in a forwarded, DKIM-verified email, when they are not yet a vendor.
--
-- John's ruling 2026-09-30 (option A): an existing vendor matched exactly is
-- linked live; a business that is NOT a vendor yet is staged HERE, because a
-- vendor row is a public page. An operator approves (creates + links) or
-- rejects via the MCP `review_exhibitor_proposal` tool.
--
-- One row per (inbound email, event): a workflow retry or replay stages nothing
-- twice. No writes to existing tables.
CREATE TABLE IF NOT EXISTS exhibitor_proposals (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  inbound_email_id TEXT NOT NULL,
  business_name    TEXT,
  website          TEXT,
  sender_address   TEXT,
  city             TEXT,
  state            TEXT,
  booth_info       TEXT,
  evidence         TEXT,
  -- pending | approved | rejected
  status           TEXT NOT NULL DEFAULT 'pending',
  resolved_vendor_id TEXT,
  resolution_note  TEXT,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_exhibitor_proposals_email_event
  ON exhibitor_proposals (inbound_email_id, event_id);
CREATE INDEX IF NOT EXISTS idx_exhibitor_proposals_status
  ON exhibitor_proposals (status, created_at);

-- OPE-246 — heartbeat probe for the new writer, seeded DORMANT (enabled_at NULL):
-- a self-announcement is rare (one specimen to date), so no window can be set
-- from measurement yet. Same stance as roster-vendor-link (OPE-847 → OPE-848):
-- arming is its own ticket. No FK, so this is a plain insert on an empty db.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'self-announced-exhibitor',
  NULL,
  'OPE-1139 — submit@ self-announcement → exhibitor link/proposal. Dormant until armed with a measured window.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

-- OPE-1265 — MMATF's own address for promoter mailing lists.
--
-- John's ruling (2026-10-01): subscribe our own address to promoter lists so
-- newsletters arrive directly (DKIM-signed by the promoter's ESP) instead of
-- through a person's forward. lists@ / lists+<promoter-slug>@ route to the MCP
-- Worker; nothing sent there ever draws a reply.
--
-- promoter_list_subscriptions — the registry: one row per (promoter, address)
-- we signed up with. Written by MCP tools (create/list/update), and its
-- last_received_at / issue_count move on every arrival.
CREATE TABLE IF NOT EXISTS promoter_list_subscriptions (
  id TEXT PRIMARY KEY,
  promoter_id TEXT NOT NULL REFERENCES promoters(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  signup_url TEXT,
  esp TEXT,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'confirmed', 'active', 'unsubscribed', 'bounced')),
  requested_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  last_received_at INTEGER,
  issue_count INTEGER NOT NULL DEFAULT 0,
  confirm_url TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_promoter_list_subscriptions_addr
  ON promoter_list_subscriptions (promoter_id, address);
CREATE INDEX IF NOT EXISTS idx_promoter_list_subscriptions_status
  ON promoter_list_subscriptions (status);

-- promoter_list_arrivals — one row per inbound email to lists@/lists+*@: who it
-- is attributed to and on what basis, whether it is a double-opt-in
-- confirmation (and its confirm link), and whether the sender looks unrelated
-- to the tagged promoter (a shared or sold list — recorded, never acted on).
-- A join table rather than new columns on the hot inbound_emails table.
CREATE TABLE IF NOT EXISTS promoter_list_arrivals (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL UNIQUE REFERENCES inbound_emails(id) ON DELETE CASCADE,
  promoter_id TEXT REFERENCES promoters(id) ON DELETE SET NULL,
  match_basis TEXT NOT NULL CHECK (match_basis IN ('subscription-address', 'unattributed')),
  plus_tag TEXT,
  subscription_id TEXT REFERENCES promoter_list_subscriptions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'issue')),
  confirm_url TEXT,
  sender_domain TEXT,
  sender_mismatch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promoter_list_arrivals_promoter
  ON promoter_list_arrivals (promoter_id, created_at);

-- Heartbeat (OPE-246): DORMANT. The population is empty until the analyst pilot
-- (OPE-1266) subscribes, and the lists@ Email Routing rule must exist first. Set
-- enabled_at the day the first real arrival lands.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('promoter-list-arrival', NULL, 'OPE-1265: dormant until the first subscription is confirmed and mail arrives at lists@', unixepoch());

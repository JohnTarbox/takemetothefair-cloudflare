-- OPE-1510 — the contact-mail lane (John, 2026-10-20 ruling; approved 2026-11-10).
--
-- A known contact's email gets no automatic ack. It opens a `contact` obligation
-- with a one-business-day target, and queues one draft for John to approve.
--
-- inbound_emails.known_contact_*: who recognised the sender, recorded on the row.
-- support_obligations.kind / target_at: contact obligations stay countable apart.
-- operator_outbound_drafts.inbound_email_id: what the draft answers. The partial
-- unique index keeps a Workflow retry or a fan-out sibling from queueing a second.
--
-- Safe on an EMPTY database: nullable or defaulted ALTERs, one index, and one
-- heartbeat seed row that references nothing.
ALTER TABLE inbound_emails ADD COLUMN known_contact_basis TEXT;
ALTER TABLE inbound_emails ADD COLUMN known_contact_entity_type TEXT;
ALTER TABLE inbound_emails ADD COLUMN known_contact_entity_id TEXT;
ALTER TABLE support_obligations ADD COLUMN kind TEXT NOT NULL DEFAULT 'support';
ALTER TABLE support_obligations ADD COLUMN target_at INTEGER;
ALTER TABLE operator_outbound_drafts ADD COLUMN inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX uq_operator_outbound_inbound ON operator_outbound_drafts(inbound_email_id) WHERE inbound_email_id IS NOT NULL;

-- OPE-246: a new execution path ships with its probe. ARMED at ship.
INSERT OR IGNORE INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES ('contact-lane', unixepoch(), 'OPE-1510: contact obligation opened by the contact-mail lane', unixepoch());

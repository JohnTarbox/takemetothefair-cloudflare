-- OPE-177 — ingest Cloudflare Email Sending delivery events, so "sent" stops
-- being the last thing we know about an email.
--
-- Heather Santiago registered as a VENDOR on 2026-07-11, asked for the
-- confirmation email three times, and received none. All three sends read
-- status='sent', provider='cf-email', no error. She was not suppressed. The
-- ledger was not lying: `sent` means the provider ACCEPTED the message. It has
-- never meant delivered, and we had no signal that could tell the difference.
--
-- Cloudflare shipped Queues event subscriptions for Email Sending on
-- 2026-07-15 -- three days after this ticket was filed -- publishing
-- message.delivered / deferred / bounced / failed / rejected / complained. This
-- migration is the storage half of consuming them.
--
-- ---------------------------------------------------------------------------
-- Why `status` is NOT widened, which is what the ticket asked for
-- ---------------------------------------------------------------------------
--
-- The instruction was: widen email_send_ledger.status from
-- ('sent','failed','stubbed') to also carry delivered/bounced/deferred/
-- complained, auditing consumers first. The audit was done first, and it says
-- do not do that. Two consumers read the literal 'sent' as a control decision,
-- not as a display value:
--
--   1. mcp-server/src/mailer.ts:74 -- `wasEmailSent()` returns
--      `rows[0].status === "sent"`. It is the idempotency guard for the
--      at-least-once email-jobs queue. Overwrite a row with 'delivered' and the
--      guard reads "not sent yet"; the next redelivery of that queue message
--      SENDS THE EMAIL AGAIN. A duplicate verification email to a real person,
--      caused by recording a success.
--
--   2. src/lib/heartbeat.ts:197 -- the `email-send` OPE-246 probe is
--      `max(sent_at) WHERE status='sent'`. As rows aged into 'delivered' the
--      probe's evidence would vanish and it would red the digest for a lane
--      that is working perfectly.
--
-- (Also src/app/api/admin/sent-emails/route.ts filters on a caller-supplied
-- status list, and gsc-sweep.ts keys on 'stubbed' -- both merely need to learn
-- the new values, but 1 and 2 are correctness, not cosmetics.)
--
-- The root problem is that "did the send call succeed" and "did the mail arrive"
-- are two different facts with different lifetimes, and one column cannot hold
-- both without one of them destroying the other. So `status` keeps its meaning
-- and delivery gets its own column. A `sent` row is still distinguishable from a
-- delivered one -- which is the acceptance criterion -- it is just read from
-- delivery_status instead of status.
--
-- ---------------------------------------------------------------------------
-- Why a separate events table and not update-in-place
-- ---------------------------------------------------------------------------
--
-- The join key is UNPROVEN. We store provider_message_id as the RFC 5322
-- Message-ID the CF binding hands back -- verified in prod, 434 of 434
-- cf-email rows carry one, all of the form
-- `<jvOB30vgYx7cUUbvhGvxF1GifPFu2hSVWSaK@meetmeatthefair.com>`. The documented
-- event payload carries `payload.messageId` shaped like
-- `0101018f7d0c4d9a-msg-deadbeef`. Those may be the same identifier rendered
-- two ways, or they may not be, and no amount of reading settles it -- only a
-- real event does.
--
-- An update-only consumer that cannot match writes nothing, logs nothing, and
-- is indistinguishable from "no mail has bounced". That is precisely the
-- shipped-but-silently-not-executing class this codebase has hit at least nine
-- times. Landing every event in its own table first means ingestion is provable
-- even if matching is broken, and unmatched rows become a queryable defect
-- rather than an absence.
--
-- event_id as PK is also the idempotency key: Queues are at-least-once, so the
-- same bounce redelivers, and ON CONFLICT DO NOTHING makes that free instead of
-- double-suppressing an address.
ALTER TABLE email_send_ledger ADD COLUMN delivery_status TEXT;
ALTER TABLE email_send_ledger ADD COLUMN delivery_updated_at INTEGER;
ALTER TABLE email_send_ledger ADD COLUMN delivery_detail TEXT;

-- The consumer resolves a ledger row by provider_message_id on EVERY event.
-- There was no index on that column -- it was write-only audit data until now --
-- so without this every delivery event is a full scan of the ledger.
CREATE INDEX IF NOT EXISTS idx_email_send_ledger_provider_message_id
  ON email_send_ledger(provider_message_id);

CREATE INDEX IF NOT EXISTS idx_email_send_ledger_delivery_status
  ON email_send_ledger(delivery_status);

CREATE TABLE IF NOT EXISTS email_delivery_events (
  event_id              TEXT PRIMARY KEY,
  event_type            TEXT NOT NULL,
  status                TEXT NOT NULL,
  provider_message_id   TEXT,
  recipient             TEXT,
  sender                TEXT,
  subject               TEXT,
  terminal              INTEGER,
  smtp_status_code      TEXT,
  smtp_response         TEXT,
  bounce_type           TEXT,
  bounce_classification TEXT,
  event_timestamp       INTEGER,
  received_at           INTEGER NOT NULL,
  ledger_message_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_received_at
  ON email_delivery_events(received_at);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_provider_message_id
  ON email_delivery_events(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recipient
  ON email_delivery_events(recipient);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_status
  ON email_delivery_events(status);

-- The reconciliation surface: events we ingested but could not attribute to a
-- send. Partial, so it stays empty-and-tiny in the healthy case and is the exact
-- scan for "is the id-space assumption wrong?".
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_unmatched
  ON email_delivery_events(received_at)
  WHERE ledger_message_id IS NULL;

-- OPE-246 — the probe ships WITH the writer.
--
-- enabled_at is NULL DELIBERATELY. The producer is an account-level Cloudflare
-- event subscription, not code in this repo: until that subscription exists this
-- queue is silent BY DESIGN, and an enabled probe would red the digest for a
-- correctly-deployed consumer. NULL keeps it dormant. Flip it (set enabled_at =
-- unixepoch()) on the day the subscription is created and the first event lands
-- -- that is the same day this stops being a prediction.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'email-delivery-events',
  NULL,
  'OPE-177 — CF Email Sending event subscription -> email-delivery-events queue -> email_delivery_events rows. Dormant until the subscription is created.',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

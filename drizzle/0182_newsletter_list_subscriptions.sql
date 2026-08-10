-- OPE-191 — audience lists for the newsletter.
--
-- Until now there was exactly ONE list: `newsletter-broadcast.ts` selected every
-- confirmed, non-unsubscribed subscriber, and its own comment called that "the
-- ONLY definition of 'the list'". Adding a vendor-facing digest on top of that
-- would have mailed a vendor newsletter to all 17 attendee subscribers.
--
-- WHY A JUNCTION, not the `newsletter_subscribers.list` column the ticket
-- suggested as an option: `newsletter_subscribers.email` is UNIQUE, so a column
-- could never put one address on two digests — which is exactly the
-- independence the acceptance criterion requires.
--
-- Per-list unsubscribe lives here (`unsubscribed_at`). The global
-- `newsletter_subscribers.unsubscribed` flag still wins over everything, so a
-- one-click unsubscribe keeps meaning "stop all mail" and nobody can be
-- resurrected by a list row.
CREATE TABLE IF NOT EXISTS newsletter_list_subscriptions (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  list TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  unsubscribed_at INTEGER,
  UNIQUE (subscriber_id, list)
);
CREATE INDEX IF NOT EXISTS idx_newsletter_list_subs_list ON newsletter_list_subscriptions(list);

-- BACKFILL (bulk mutation — idempotent, single-writer, read-back-verified).
--
-- Every existing CONFIRMED subscriber joins the `weekend` list, so the attendee
-- digest keeps exactly the audience it has today. Without this, making the list
-- argument required would silently empty the weekend broadcast.
--
-- `INSERT OR IGNORE` + the UNIQUE constraint make re-running a no-op. Only
-- confirmed subscribers are enrolled: an unconfirmed address was never eligible,
-- and enrolling it would quietly widen the audience.
INSERT OR IGNORE INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at)
SELECT
  lower(hex(randomblob(16))),
  id,
  'weekend',
  unixepoch()
FROM newsletter_subscribers
WHERE confirmed = 1;

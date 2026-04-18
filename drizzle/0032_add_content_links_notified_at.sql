-- Phase: promoter notifications for editorially-linked events.
-- notified_at is stamped the first time we successfully fire a blog-mention
-- email to the promoter of a linked event. Keeping it on the link row (rather
-- than a separate notifications table) makes the feature survivable across
-- blog-post re-saves: if the link is deleted and re-added, notified_at goes
-- back to NULL (because the row is new) and we fire again. If the link stays
-- put, the column stays stamped — no duplicate emails.

ALTER TABLE content_links ADD COLUMN notified_at INTEGER;

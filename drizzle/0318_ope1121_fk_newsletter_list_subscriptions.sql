-- OPE-1121 Phase 2 (11/13): newsletter_list_subscriptions gains its foreign key.
--
-- subscriber_id → newsletter_subscribers(id) ON DELETE CASCADE. The UNIQUE (subscriber_id, list) autoindex already covers the child column.
--
-- Hand-written SQLite 12-step rebuild of a CHILD-ONLY table (no table
-- references newsletter_list_subscriptions; checked against prod sqlite_master 2026-09-23, along with
-- 0 triggers and 0 views on it). Never a parent: D1 always enforces FKs, and
-- DROP TABLE on a parent runs an implicit DELETE that fires ON DELETE actions.
-- Orphans on the new FK column in prod, re-measured 2026-09-23: 0.
--
-- Failure safety does NOT rely on the file being atomic. wrangler sends this
-- file and its d1_migrations INSERT as ONE /query request (wrangler 4.131
-- buildMigrationQuery + executeRemotely); D1 documents batch() as a
-- transaction but says nothing either way for a multi-statement /query. So
-- every check that can fail — an orphan the INSERT rejects, the count check —
-- runs BEFORE the DROP of the original table. A failure there leaves the
-- original untouched, and the two DROP IF EXISTS lines below clear any
-- leftover scratch table, so a re-run starts clean.
--
-- NO `PRAGMA defer_foreign_keys`. The rehearsal (OPE-1121 PR) planted one
-- orphan and, WITH deferral, this rebuild copied it, declared the FK anyway,
-- and recorded the migration: the deferred check never fired. Deferral is not
-- needed here — no parent is touched — so the FK is checked row by row on the
-- INSERT, and the assertion below counts orphans explicitly as well, so a
-- failure does not depend on pragma semantics at all.

DROP TABLE IF EXISTS newsletter_list_subscriptions__ope1121;
DROP TABLE IF EXISTS _ope1121_count_check;

CREATE TABLE newsletter_list_subscriptions__ope1121 (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  list TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  unsubscribed_at INTEGER,
  UNIQUE (subscriber_id, list)
);

INSERT INTO newsletter_list_subscriptions__ope1121 (id, subscriber_id, list, created_at, unsubscribed_at)
SELECT id, subscriber_id, list, created_at, unsubscribed_at FROM newsletter_list_subscriptions;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1121_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1121_count_check
SELECT (SELECT count(*) FROM newsletter_list_subscriptions__ope1121) = (SELECT count(*) FROM newsletter_list_subscriptions)
   AND (SELECT count(*) FROM newsletter_list_subscriptions__ope1121 c WHERE c.subscriber_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM newsletter_subscribers p WHERE p.id = c.subscriber_id)) = 0;
DROP TABLE _ope1121_count_check;

DROP TABLE newsletter_list_subscriptions;
ALTER TABLE newsletter_list_subscriptions__ope1121 RENAME TO newsletter_list_subscriptions;

CREATE INDEX idx_newsletter_list_subs_list ON newsletter_list_subscriptions(list);

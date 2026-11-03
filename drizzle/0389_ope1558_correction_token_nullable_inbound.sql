-- OPE-1558 decision 1a (John, 2026-11-02): web-form submissions get a private
-- correction link in their receipt, so a correction token no longer always
-- comes from an inbound email. submission_correction_tokens.inbound_email_id
-- goes from NOT NULL to NULLABLE; the FK (ON DELETE CASCADE) and its index stay.
-- NULL = minted for a web-form submission (/list-your-event), not an email.
--
-- Same hand-written 12-step rebuild as 0313 (which this re-declares, changing
-- only the NOT NULL): a CHILD-ONLY table — nothing references
-- submission_correction_tokens (0313's prod sqlite_master check; no later
-- migration adds a referencing table, grep'd 2026-11-02). Never a parent, so
-- DROP TABLE fires no ON DELETE action.
--
-- Failure safety does not rely on the file being atomic: every check that can
-- fail runs BEFORE the original is dropped, and the two DROP IF EXISTS lines
-- clear any leftover scratch table so a re-run starts clean. NO
-- `PRAGMA defer_foreign_keys` — 0313's rehearsal showed deferral lets a planted
-- orphan through; the FK is checked row by row on the INSERT, and the assertion
-- counts orphans explicitly as well.
--
-- On an EMPTY database (CI's fresh D1) this copies 0 rows and the assertion is
-- 0 = 0 AND 0 AND 0, so it applies cleanly.

DROP TABLE IF EXISTS submission_correction_tokens__ope1558;
DROP TABLE IF EXISTS _ope1558_count_check;

CREATE TABLE submission_correction_tokens__ope1558 (
  token TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  inbound_email_id TEXT REFERENCES inbound_emails(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO submission_correction_tokens__ope1558 (token, event_id, inbound_email_id, expires_at, used_at, created_at)
SELECT token, event_id, inbound_email_id, expires_at, used_at, created_at FROM submission_correction_tokens;

-- Assertion: aborts the file, BEFORE the original is dropped, unless every
-- row was copied AND no copied row points at a missing parent.
CREATE TABLE _ope1558_count_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _ope1558_count_check
SELECT (SELECT count(*) FROM submission_correction_tokens__ope1558) = (SELECT count(*) FROM submission_correction_tokens)
   AND (SELECT count(*) FROM submission_correction_tokens__ope1558 c WHERE NOT EXISTS (SELECT 1 FROM events p WHERE p.id = c.event_id)) = 0
   AND (SELECT count(*) FROM submission_correction_tokens__ope1558 c WHERE c.inbound_email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inbound_emails p WHERE p.id = c.inbound_email_id)) = 0;
DROP TABLE _ope1558_count_check;

DROP TABLE submission_correction_tokens;
ALTER TABLE submission_correction_tokens__ope1558 RENAME TO submission_correction_tokens;

CREATE INDEX idx_submission_correction_tokens_event ON submission_correction_tokens (event_id);
CREATE INDEX idx_submission_correction_tokens_expires ON submission_correction_tokens (expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_submission_correction_tokens_inbound ON submission_correction_tokens (inbound_email_id);

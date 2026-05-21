-- Tracks which extraction strategy produced the event from this inbound row.
--
-- Values:
--   'json-ld'    — Event-schema JSON-LD on the fetched page produced a
--                  complete-enough ExtractedEventData; Workers AI was NOT
--                  called for this row. Authoritative source.
--   'ai'         — Workers AI Llama 3.1 8B extracted from page prose
--                  (current default before this PR).
--   'free-text'  — No URL in the email; AI extracted directly from the
--                  email body. Reserved for PR-E B2.
--   'mixed'      — Partial JSON-LD + AI top-up. Reserved for the hybrid
--                  follow-up (out of scope for PR-B).
--
-- NULL on pre-existing rows. New rows from the inbound workflow always
-- write a non-NULL value once PR-B's workflow change is deployed.

ALTER TABLE inbound_emails ADD COLUMN extraction_method TEXT;

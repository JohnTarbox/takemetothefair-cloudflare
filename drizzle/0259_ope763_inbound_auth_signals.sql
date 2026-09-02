-- OPE-763 — keep the bytes that tell a spoofer from a state official.
--
-- ── What was actually wrong ───────────────────────────────────────────────
--
-- The ticket reads "we discard every signal". Closer: Cloudflare Email Routing
-- DOES attach `Authentication-Results`, and `email-handler.ts:311` has been
-- reading it since WS3e shipped on 2026-06-11. It is condensed to
-- pass/fail/unknown, used to gate the trusted-sender fast-path, and then
-- dropped on the floor. We were not blind at the transport; we were amnesiac
-- one line after looking.
--
-- Empirical confirmation that the header is genuinely present (scope 1), from
-- prod on 2026-09-02: 72 messages from a trusted sender arrived inside the
-- `error_logs` retention window, and NONE produced the WS3e
-- "trusted sender ... not a clean pass" log — a log that fires whenever the
-- verdict is anything but `pass`. Seventy-two consecutive passes require the
-- header to be there and to carry passing results.
--
-- ⚠️ That evidence is a NEGATIVE, so it was checked against the inert case
-- before being believed: the same silence would appear if no trusted sender
-- had ever written. 72 messages inside the window from 1 distinct trusted
-- sender is the positive landmark that rules that out.
--
-- ── Report-only ───────────────────────────────────────────────────────────
--
-- These columns are written and read. NOTHING branches on them: no routing,
-- no template selection, no send decision, no blocking. Acting on the verdict
-- is OPE-764/OPE-765's business, kept separate precisely so an auth-parsing
-- bug cannot silently start dropping real mail.
--
-- ── Empty-database safety ─────────────────────────────────────────────────
--
-- Pure ALTER TABLE ADD COLUMN. No INSERT, no UPDATE, no FK reference, nothing
-- that can abort a fresh-database run. Every column is nullable with no
-- default, because NULL here means "this message predates capture" and must
-- stay distinguishable from "the transport supplied nothing" (which is
-- `sender_auth='unknown'` with a non-null row).
--
-- ── Backfill ──────────────────────────────────────────────────────────────
--
-- Impossible, and deliberately not attempted. The headers were never stored,
-- and `raw_size` is an integer. Every pre-deploy row keeps NULL forever.

ALTER TABLE inbound_emails ADD COLUMN auth_results_raw TEXT;
ALTER TABLE inbound_emails ADD COLUMN spf_result TEXT;
ALTER TABLE inbound_emails ADD COLUMN dkim_result TEXT;
ALTER TABLE inbound_emails ADD COLUMN dmarc_result TEXT;

-- Derived, so consumers never re-parse the header: pass | partial | fail |
-- unknown. `partial` is the value the WS3e 3-value verdict cannot express —
-- "something authenticated, nothing failed" — which covers an ordinary
-- mailing-list forward (spf=fail, dkim=pass) and a plain spf=pass with no
-- DKIM. Collapsing those into `pass` is what makes an audit trail useless.
ALTER TABLE inbound_emails ADD COLUMN sender_auth TEXT;

-- The classic spoof tells, none of which we kept.
--   from_display_name — `"Jeremy Hall" <random@gmail.com>`
--   reply_to          — reply somewhere other than the visible sender
--   return_path       — bounce elsewhere again
--   sending_host      — the real Jeremy Hall came via
--                       PH0PR09MB11424.namprd09.prod.outlook.com, a Microsoft
--                       365 tenant, which is checkable; we checked nothing
--                       because we kept nothing.
ALTER TABLE inbound_emails ADD COLUMN from_display_name TEXT;
ALTER TABLE inbound_emails ADD COLUMN reply_to TEXT;
ALTER TABLE inbound_emails ADD COLUMN return_path TEXT;
ALTER TABLE inbound_emails ADD COLUMN sending_host TEXT;

-- Partial: the overwhelming majority of rows will be `pass`, and the queries
-- worth running are "show me everything that did not". Indexing the whole
-- column would be mostly dead weight.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_sender_auth
  ON inbound_emails(sender_auth)
  WHERE sender_auth IS NOT NULL AND sender_auth <> 'pass';

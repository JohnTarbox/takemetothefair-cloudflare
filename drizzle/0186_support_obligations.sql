-- OPE-365 (R1) — "does a human owe this person a response?" gets its own record.
--
-- Katie emailed hello@ on 2026-08-10 to report that the signup page was
-- unusable on her iPhone. The pipeline classified her correctly (support, 0.90,
-- accurate rationale), auto-acked her in six seconds, marked the row 'replied',
-- and stopped. Nothing anywhere recorded that a human still owed her something.
-- She was helped only because Cloudflare forwards hello@ into John's personal
-- Gmail and he happened to read it.
--
-- The existing signal is `inbound_emails.flagged_for_review`, and it answers a
-- DIFFERENT question: "was the classifier unsure?" Across all 232 rows, every
-- flagged row scores ≤0.82 (mean 0.32) while unflagged rows average 0.92. So
-- the clearer a customer describes their problem, the more confident the
-- classifier, and the less likely a human ever sees it. Katie wrote a textbook
-- bug report, scored 0.90, and was invisible. That flag stays exactly as it is,
-- for classifier QA. This table answers the other question.
--
-- ── Why not problem_reports ─────────────────────────────────────────────────
-- Checked first, as the ticket asked. It is NOT an unwired membrane: it is a
-- working lane for a different intent — `problem_report` from report@/feedback@
-- → handleProblemReport → intakeProblemReport, with burst correlation and HIGH
-- severity escalation. Its 3 rows are 1 web claim-evidence submission and 2
-- email rows from 2026-06-04 (a "testinr" test and a Cloudflare Email Routing
-- verification notice). The lane works; it has simply never had real traffic.
--
-- Not overloaded, for one concrete reason: `get_problem_report_open_count` is a
-- live operator metric over a 3-row defect queue. Pouring every support email
-- into it would change what that number means overnight — the same "changed
-- what the number counts" hazard this whole R-series is about.
--
-- ── Why there is no cleverness about spam ───────────────────────────────────
-- The SEO cold-outreach from wayne@plushcargo.com, james@dowebnseo.com and
-- holly@plushcargo.com is ALSO classified `support` (0.82), with the same
-- reply_kind and a null sub_intent. Nothing already in the row separates them
-- from Katie. The temptation is a heuristic; that is precisely how this bug was
-- built. The system guessed importance and guessed backwards.
--
-- So every qualifying support email opens a record, and a HUMAN closes it —
-- with the reason recorded, so "answered" and "was never a real obligation"
-- stay countable apart. A queue a person drains in seconds beats a classifier
-- that is confidently wrong.
CREATE TABLE IF NOT EXISTS support_obligations (
  id TEXT PRIMARY KEY,
  -- One obligation per inbound. UNIQUE makes the writer and the backfill
  -- idempotent by construction rather than by convention.
  inbound_email_id TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  subject TEXT,
  -- Recorded but NEVER used to decide whether to open the record. Kept so the
  -- inversion this table exists to fix stays measurable: if obligations only
  -- ever open above some confidence, that is visible here.
  classified_confidence REAL,
  opened_at INTEGER NOT NULL,
  -- open | answered | not_an_obligation | duplicate
  --
  -- `answered` and `not_an_obligation` are deliberately distinct. Collapsing
  -- them into "closed" would make a drained queue and an ignored queue look
  -- identical — the failure already sitting in inbound_exceptions, which has
  -- held depth 33 with outflow_1d=0 and drain_ratio_7d=0.
  status TEXT NOT NULL DEFAULT 'open',
  closed_at INTEGER,
  closed_by TEXT,
  close_note TEXT
);

-- The operator's view: what is open, oldest first. Also the ageing query.
CREATE INDEX IF NOT EXISTS idx_support_obligations_status
  ON support_obligations(status, opened_at);

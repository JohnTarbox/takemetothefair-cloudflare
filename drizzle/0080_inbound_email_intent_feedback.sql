-- 2026-05-20 (Phase D.1): Feedback substrate for the intent classifier.
-- Single table that captures every ground-truth correction to a
-- classifier decision, regardless of source: admin reclassification,
-- workflow outcome inference, sender click-through (Phase D.3), or
-- admin-confirmed correct label (active labeling for low-confidence
-- rows that turned out fine).
--
-- The same shape will be reused by future AI-decision feedback tables
-- (extraction quality, JSON-LD parser, free-text extraction) per spec
-- §D.4.3 — each gets its own table with the same column conventions.
--
-- feedback_source semantics:
--   admin_reroute     — admin used the D.1 reclassify dropdown to
--                       change inbound_emails.intent. corrected_intent
--                       is the admin's pick.
--   admin_label       — admin clicked "Mark as correctly classified"
--                       on a low-confidence row. corrected_intent
--                       equals original_intent (active labeling).
--   workflow_outcome  — implicit signal from downstream:
--                       * PENDING → APPROVED (no admin intent change)
--                         confirms new_event
--                       * REJECTED with reason "not an event" / "spam"
--                         contradicts new_event
--   sender_feedback   — D.3 click-through. Highest-trust source per
--                       spec §D.3.
--   user_reply        — sender wrote text matching "I wanted to ..."
--                       patterns; admin reviewed and labeled. Weak
--                       negative until human-confirmed.
--
-- One inbound row CAN have multiple feedback rows (e.g. admin_reroute
-- followed by sender_feedback) — they accumulate, downstream queries
-- prioritize by feedback_source.

CREATE TABLE inbound_email_intent_feedback (
  id TEXT PRIMARY KEY,
  inbound_email_id TEXT NOT NULL,
  -- Source of the ground-truth signal. See semantics block above.
  feedback_source TEXT NOT NULL,
  -- What the classifier originally picked. NULL when feedback is
  -- generated for a pre-classifier row (e.g. admin retroactively
  -- labels an older row).
  original_intent TEXT,
  -- The corrected intent (what the source believes is right).
  corrected_intent TEXT NOT NULL,
  -- Classifier version stamp. Lets the D.1 dashboard compute accuracy
  -- by version so a prompt revision's regression / improvement is
  -- attributable.
  classifier_version TEXT,
  -- Optional free-text rationale from admin or sender.
  admin_note TEXT,
  -- Admin user_id who recorded the feedback. NULL for non-admin
  -- sources (workflow_outcome, sender_feedback).
  created_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (inbound_email_id) REFERENCES inbound_emails(id)
);

-- Per-row feedback lookup (admin row-detail view).
CREATE INDEX idx_intent_feedback_email
  ON inbound_email_intent_feedback(inbound_email_id);

-- D.4 dashboard filters by feedback_source.
CREATE INDEX idx_intent_feedback_source
  ON inbound_email_intent_feedback(feedback_source);

-- "Accuracy by classifier_version" queries (see spec §"Manual
-- verification queries"). Partial because most feedback rows have a
-- version stamp; pre-classifier feedback (NULL) shouldn't pollute the
-- partition.
CREATE INDEX idx_intent_feedback_version
  ON inbound_email_intent_feedback(classifier_version)
  WHERE classifier_version IS NOT NULL;

-- Time-windowed dashboard queries (rolling-30d accuracy).
CREATE INDEX idx_intent_feedback_created
  ON inbound_email_intent_feedback(created_at);

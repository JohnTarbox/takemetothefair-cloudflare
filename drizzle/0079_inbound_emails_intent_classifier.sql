-- 2026-05-20 (Phase C.1): Smart intent classifier — adds classifier output
-- columns + multi-intent parent linkage + admin review flag to inbound_emails.
--
-- The pipeline today routes by `to_address` only (mcp-server/src/email-intents.ts).
-- This migration prepares the table for an LLM classifier that runs in
-- mcp-server/src/email-handler.ts between rate-limit and INSERT. The
-- classifier's prediction + confidence + rationale are stored alongside the
-- routed intent so we can audit, A/B prompt revisions by classifier_version,
-- and feed Phase D.1's accuracy dashboard.
--
-- Column semantics:
--   classified_intent       — LLM's predicted intent from the 9-value
--                             taxonomy (new_event | source_suggestion |
--                             correction | claim_request | vendor_inquiry |
--                             support | press | unsubscribe | spam |
--                             unclear). NULL on rows from before the
--                             classifier shipped.
--   classified_sub_intent   — Sub-intent for new_event only (single_url |
--                             multi_url | free_text | attachment_only |
--                             mixed). NULL otherwise.
--   classified_confidence   — 0.0–1.0 confidence score from the LLM.
--   classified_rationale    — One-sentence explanation; useful in admin
--                             queue for low-confidence rows.
--   classified_at           — When the classifier ran. Distinct from
--                             received_at because the classifier may run
--                             post-INSERT (workflow step) if budget is
--                             tight at the entrypoint.
--   classifier_version      — Fingerprint of prompt + model (e.g.
--                             c-2026-05-20-v1). Lets us roll back a bad
--                             prompt revision and measure accuracy by
--                             version in the D.1 dashboard.
--   routing_source          — How the row was actually routed:
--                             'classifier'                — classifier intent used (confidence ≥ threshold)
--                             'classifier_override'       — classifier disagreed with to_address; classifier won
--                             'fallback_low_confidence'   — confidence < threshold; address-based intent used + flagged
--                             'trusted_fastpath'          — sender_trust=trusted + regex pre-check clean; classifier skipped
--                             'address_only'              — pre-classifier row OR classifier errored
--   routed_to_workflow      — Workflow ID the row dispatched to (for
--                             multi-intent children, the per-child workflow).
--   flagged_for_review      — Admin queue surfacing flag. Set when
--                             confidence < threshold, when multi-intent
--                             splitting fell back, or when admin clicks
--                             "Flag for next prompt revision" in the D.1 UI.
--   parent_email_id         — Multi-intent split linkage. NULL for normal
--                             rows. For parent rows, NULL + intent='multi'.
--                             For child rows, points to the parent's id.
--                             Lets the multi-section receipt template (D.3)
--                             enumerate per-child outcomes.
--
-- Routed intent (existing `intent` column from drizzle/0072): extended from
-- 6 values to 11 by convention. Old values (submit | correction | support |
-- press | unsubscribe | unknown) stay readable for pre-classifier rows;
-- new values (new_event | source_suggestion | claim_request |
-- vendor_inquiry | spam | unclear | multi) are written by the classifier
-- branch. No backfill required — `submit` and `new_event` are recognized
-- by downstream handlers as the same target workflow.

ALTER TABLE inbound_emails ADD COLUMN classified_intent TEXT;
ALTER TABLE inbound_emails ADD COLUMN classified_sub_intent TEXT;
ALTER TABLE inbound_emails ADD COLUMN classified_confidence REAL;
ALTER TABLE inbound_emails ADD COLUMN classified_rationale TEXT;
ALTER TABLE inbound_emails ADD COLUMN classified_at INTEGER;
ALTER TABLE inbound_emails ADD COLUMN classifier_version TEXT;
ALTER TABLE inbound_emails ADD COLUMN routing_source TEXT;
ALTER TABLE inbound_emails ADD COLUMN routed_to_workflow TEXT;
ALTER TABLE inbound_emails ADD COLUMN flagged_for_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbound_emails ADD COLUMN parent_email_id TEXT REFERENCES inbound_emails(id);

-- Multi-intent child lookup ("show me the children of this parent row").
CREATE INDEX idx_inbound_emails_parent
  ON inbound_emails(parent_email_id)
  WHERE parent_email_id IS NOT NULL;

-- D.1 dashboard filters group by classified_intent; partial because pre-
-- classifier rows have NULL and don't need to be in the index.
CREATE INDEX idx_inbound_emails_classified_intent
  ON inbound_emails(classified_intent)
  WHERE classified_intent IS NOT NULL;

-- Admin queue "show me low-confidence / flagged rows" filter.
CREATE INDEX idx_inbound_emails_flagged
  ON inbound_emails(flagged_for_review)
  WHERE flagged_for_review = 1;

-- Accuracy queries group by classifier_version (see spec §"Manual
-- verification queries"). Partial because pre-classifier rows have NULL.
CREATE INDEX idx_inbound_emails_classifier_version
  ON inbound_emails(classifier_version)
  WHERE classifier_version IS NOT NULL;

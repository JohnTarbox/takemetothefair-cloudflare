-- OPE-1082 — persist the capture path's "never a promoter-outreach candidate"
-- decision. It was written only as outreach_candidate = 0, which the
-- re-ranker recomputes from score, so a manual rerank past 24h undid it.
ALTER TABLE event_discrepancies ADD COLUMN outreach_suppressed INTEGER NOT NULL DEFAULT 0;

-- Backfill from STORED facts only (each writer stamps its reason in notes or
-- detected_by). No-op on an empty table. instr(), not LIKE (D1 LIKE cap).
UPDATE event_discrepancies SET outreach_suppressed = 1
WHERE detected_by IN ('source_agreement', 'citation_flag')
   OR (detected_by = 'stale_page_radar' AND (
        instr(notes, '[target=aggregator') > 0
     OR instr(notes, '[target=unknown') > 0
     OR instr(notes, 'OPE-987 organizer-page cancellation notice') > 0));

-- A suppressed row is never a candidate, whatever its score says today.
UPDATE event_discrepancies SET outreach_candidate = 0
WHERE outreach_suppressed = 1 AND outreach_candidate = 1;

-- OPE-769 — problem_reports is two queues in one table.
--
-- Of its 5 unresolved `web` rows, FOUR were claim-verification evidence written
-- by /api/claim/evidence as an operator notification, not defect reports. So
-- "5 open problem reports" read as five open bugs when it was ONE (aéhkō's
-- vendor-profile report, 2026-08-27). Meanwhile live claim-funnel work sat in a
-- queue no claim reviewer looks at.
--
-- DEFAULT 'defect' is the safe direction: a row of some unclassified future
-- kind appears in the queue somebody drains rather than disappearing from it.
ALTER TABLE problem_reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'defect';

-- Reclassify the existing claim-evidence rows.
--
-- Keyed on the `path` prefix that /api/claim/evidence writes, NOT on a hardcoded
-- list of the four ids: an id list would silently do nothing if a fifth row were
-- filed between this being written and being applied, and this migration would
-- still report success. Matching the writer's own shape makes it correct for
-- however many rows exist at apply time.
--
-- No-op on an EMPTY database (nothing matches), so CI's fresh-D1 run is safe.
UPDATE problem_reports
   SET kind = 'claim_evidence'
 WHERE path LIKE '/claim/verify/%';

CREATE INDEX IF NOT EXISTS idx_problem_reports_kind_resolved
  ON problem_reports (kind, resolved_at);

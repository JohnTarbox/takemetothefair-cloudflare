-- OPE-373 — distinguish HOW a health issue stopped being open.
--
-- `resolved_at` already works (283 of 633 rows carry one), but it records only
-- THAT a row closed, never why. Three very different facts currently collapse
-- into the same NULL→timestamp transition:
--
--   verified_fixed      we fetched the live URL and the condition is genuinely
--                       gone (the page emits no noindex, or returns 200)
--   passed_inspection   Google's next inspection came back PASS/SUCCESS
--   no_longer_detected  the scan simply stopped seeing it — which is NOT
--                       evidence of recovery, it is evidence of absence
--   withdrawn           the row should never have been raised (OPE-372's
--                       non-canonical URLs)
--
-- Conflating "we proved it is fixed" with "we stopped looking" destroys the
-- ability to tell recovery from blindness, and blindness is the failure mode
-- this whole queue exists to catch. Keeping them separable is the point.
--
-- Nullable with no default: rows resolved before this migration genuinely have
-- an unknown reason, and back-filling them with a guess would manufacture
-- precisely the false confidence the column exists to prevent.
ALTER TABLE health_issues ADD COLUMN resolution_reason TEXT;

-- Open-row lookups already use idx_health_issues_open (resolved_at). This one
-- serves the bucketed reporting: "how many closed, by reason, since when".
CREATE INDEX IF NOT EXISTS idx_health_issues_resolution_reason
  ON health_issues(resolution_reason, resolved_at);

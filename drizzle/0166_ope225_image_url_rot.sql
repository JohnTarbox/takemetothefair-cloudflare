-- OPE-225 PR 2/2 — URL rot detection (scope §4's measured half).
--
-- `url_health` already exists with an UNREACHABLE value (shipped unused in
-- drizzle/0165 precisely so this step needed no enum migration). What was
-- missing is the round-robin bookkeeping: which URLs have been fetched, when,
-- and what they answered.
--
-- Why a separate `url_checked_at` rather than reusing `checked_at`:
-- `checked_at` is stamped by the daily coverage scan for EVERY row, so it can
-- never express "this URL has not been fetched in 9 days". The rot sweep is
-- budget-bound (~30s of outbound wall-clock per Worker invocation) and so
-- checks only the N least-recently-fetched URLs per run; it needs its own
-- clock to round-robin against.
--
-- `url_status_code` is nullable on purpose: NULL means the fetch never produced
-- an HTTP response at all (DNS/TLS/timeout/refused), which is a materially
-- different failure from a 404 and worth being able to tell apart when
-- triaging a hotlink that "stopped working".

ALTER TABLE image_coverage_state ADD COLUMN url_checked_at INTEGER;--> statement-breakpoint
ALTER TABLE image_coverage_state ADD COLUMN url_status_code INTEGER;--> statement-breakpoint

-- The sweep's selection order: imaged rows, least-recently-checked first with
-- never-checked (NULL) ahead of them.
CREATE INDEX IF NOT EXISTS idx_image_coverage_url_check
  ON image_coverage_state (has_image, url_checked_at);--> statement-breakpoint

-- OPE-246 probe for this second writer path. Enabled on ship: the sweep runs
-- from the daily cron in the same PR, so a dormant probe would be wrong.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'image-url-health-sweep',
  strftime('%s', '2026-07-20'),
  'OPE-225 PR2 rot sweep — sweepImageUrlHealth writes image_coverage_state.url_checked_at',
  unixepoch()
)
ON CONFLICT (probe_name) DO NOTHING;

-- OPE-447 — anchor the IndexNow outage clock to something Bing controls.
--
-- The `indexnow:health` alert reported a day count that dropped twice (20 → 3
-- on 2026-07-18, 23 → 6 on 2026-08-11) and was filed as a fabricated number.
-- It was not fabricated. It was accurate about the wrong thing: it reported the
-- age of the CURRENT PAUSE, parsed out of the `indexnow:paused` KV value, and
-- `admin_actions` shows the operator legitimately re-engaging that pause three
-- times after probing Bing:
--
--   resume → resubmit (HTTP 429) → pause, ~30-60s apart, on
--   2026-06-27, 2026-07-18 and 2026-08-11.
--
-- That is correct operator behaviour — periodically testing whether Bing's
-- per-host penalty has decayed. The bug is that the severity clock was anchored
-- to the very flag being tested, so it reset every time someone checked whether
-- the outage was over.
--
-- ---------------------------------------------------------------------------
-- Why a seeded floor is needed at all
-- ---------------------------------------------------------------------------
--
-- The fix reads the outage age from the newest `status='success'` row in
-- `indexnow_submissions`. There is no such row: the table's EARLIEST row of any
-- kind is 2026-07-18, so it cannot see back to the last good submission, and an
-- unanchored calculation would report 0 days — the same silence this ticket is
-- about, in a new costume.
--
-- And this is STRUCTURAL, not a symptom of a young table. `recordSubmission`
-- (src/lib/indexnow.ts) probabilistically deletes rows older than 30 days, so
-- during any outage longer than 30 days the last success row is GUARANTEED to
-- be pruned. The submissions table can therefore never, by itself, measure the
-- outages that matter most. That is why the anchor is a durable row that the
-- success path advances (`advanceIndexNowOutageAnchor`) and why the reader
-- takes the LATEST of the two rather than preferring either: preferring the
-- table and falling back to this seed would report a fabricated multi-month
-- outage the moment a healthy success row aged out.
--
-- So this seeds a floor. The value is NOT an estimate. 2026-06-13T02:47:47Z is
-- the timestamp of the last `admin_actions` row showing Bing accepting
-- anything: `search_pings.flush` with "indexnow_response":"ok". Every attempt
-- after it failed —
--
--   2026-06-13 14:00  resubmit  429
--   2026-06-27 03:07  resubmit  429
--   2026-07-04 05:08  resubmit  503
--   2026-07-18 01:44  resubmit  429
--   2026-08-11 02:51  resubmit  503
--   2026-08-11 03:08  resubmit  429
--
-- — so the outage is continuous from that point. As of 2026-08-17 that is ~65
-- days, against the "~6" the last alert reported.
--
-- It is a FLOOR, not an override: `getIndexNowOutage` prefers any real success
-- row, so the first submission Bing accepts retires this constant permanently.
-- The reader also says "at least N days" while running off this seed, because
-- the true last success may predate it and overstating certainty is precisely
-- the failure mode here.
--
-- Stored in `tunable_thresholds` (created by OPE-413) so an operator can
-- correct it without a deploy if better evidence turns up. `unit` is explicit
-- because a bare epoch in a config table is exactly the value someone later
-- reads as milliseconds.
--
-- NOTE: this touches D1 only. It does not read, write or clear any IndexNow KV
-- key, and it does not resume submissions — the `indexnow:paused` breaker stays
-- exactly as John set it.
INSERT INTO tunable_thresholds (key, value, unit, note, updated_at)
VALUES (
  'indexnow_outage_anchor_epoch',
  1781318867, -- 2026-06-13T02:47:47Z
  'unix_epoch_seconds',
  'OPE-447 — FLOOR for the IndexNow outage clock: 2026-06-13T02:47:47Z, the last admin_actions row showing Bing accepting a submission (search_pings.flush, indexnow_response=ok). Every attempt since failed (429/503). Used ONLY when indexnow_submissions holds no status=success row; a real success always wins and retires this value. Not an estimate — change it only against better evidence of a LATER confirmed success.',
  unixepoch()
)
ON CONFLICT(key) DO NOTHING;

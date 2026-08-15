-- OPE-403 — record what the photo lane actually STORED, separately from what it
-- decided.
--
-- On 2026-08-15 five photo emails were classified `photo_intake`, matched to
-- Winthrop Arts Festival 2026 by location + timestamp (correctly, 0.25-0.29 mi
-- from the photo GPS), stamped with `resulting_event_id`, and answered with
-- `reply_kind='photo-intake-ack'`, `status='sent'`. Zero `event_photos` rows
-- were written. The event's `image_url` stayed NULL. The submitter was told
-- "Matched to: Winthrop Arts Festival 2026" and nothing else -- which reads as
-- "it is on the site".
--
-- The cause is not a broken function. `photo-intake.ts` DOES call the attach
-- path, and that path DOES write `event_photos`. It returns at
-- `booth-pipeline.ts:123` because `PHOTO_VISION_ENABLED="false"`, handing back a
-- `disabledReason` that says exactly this -- and the caller never reads that
-- field. A deliberate, loudly-announced OFF switch degraded into a silent no-op
-- because one return value went unread at one call site.
--
-- ---------------------------------------------------------------------------
-- Why a column and not a wider WHERE clause
-- ---------------------------------------------------------------------------
--
-- The state was invisible to the drain twice over, and both were the same
-- conflation:
--
--   1. `resolve_held_photos` selects `reply_kind='photo-intake-unresolved'`.
--      These rows are `photo-intake-ack`, so they are not in the queue.
--   2. Its idempotency guard skips any row that already carries
--      `resulting_event_id` (resolve-held-photos.ts:143). Every one of these
--      rows carries one -- the matcher set it. So even reached, they would be
--      skipped as "already resolved".
--
-- Guard (2) is the deeper bug: it treats "we identified the fair" as "we
-- attached the photos". Widening the `reply_kind` filter would leave it intact,
-- and a rescue run would silently skip every row it was widened to reach.
--
-- `event_photos` cannot answer this either -- it has no column referencing
-- `inbound_emails` (no `source_inbound_email_id`; `uploaded_by` is free text),
-- so "photo rows produced by this email" is not expressible today. Reconciling
-- by event + timestamp proximity would be a guess dressed as a fact.
--
-- So the fact gets recorded where the decision already lives, at the moment the
-- attach path returns.
--
-- ---------------------------------------------------------------------------
-- NULL vs 0 is load-bearing
-- ---------------------------------------------------------------------------
--
--   NULL -- the attach path was never reached. Every pre-migration row, and
--           every non-photo intent, forever. Asserts nothing.
--   0    -- the attach path RAN and stored nothing. The defect state: looks
--           complete, is not, needs draining.
--   N    -- N `event_photos` rows exist because of this email.
--
-- Deliberately NOT backfilled. Writing 0 across existing rows would mark every
-- historical email in the table as a failed photo attach and bury the real
-- signal on day one -- the same mistake 0188 avoided by leaving its cursor NULL.
--
-- The five 2026-08-15 rows are therefore NULL after this migration, not 0. They
-- were recovered by hand and deliberately left unmutated so the fingerprint
-- survives; re-attaching them would duplicate rows, since `attachGeneralPhotos`
-- is not dedup'd. They are evidence, not backlog.
ALTER TABLE inbound_emails ADD COLUMN photos_stored INTEGER;

-- Serves the reconciliation sweep directly: photo intakes that ran the attach
-- path and stored nothing. Partial index -- the defect state is rare by
-- construction, so this stays tiny and never scans the healthy majority.
CREATE INDEX IF NOT EXISTS idx_inbound_emails_photos_unstored
  ON inbound_emails(received_at)
  WHERE photos_stored = 0;

-- OPE-246 — the post-ship first-evidence probe ships WITH the writer.
--
-- Watches "is the lane still RECORDING what it stored", which is deliberately
-- NOT the same question as the reconciliation sweep this PR also adds. The
-- sweep sees rows where photos_stored = 0 (a wrong outcome). If the write is
-- ever removed, no row is ever 0, the sweep sees a clean table and reports
-- healthy -- the original defect shape, one level up. This probe is the guard
-- against that, and the sweep is the guard against the outcome. Neither
-- subsumes the other.
--
-- enabled_at = now, NOT null: the column write is unconditional on
-- PHOTO_VISION_ENABLED (it records 0 when the gate declines), so there is no
-- flag to wait on and a dormant probe would just be a probe that never runs.
INSERT INTO heartbeat_probes (probe_name, enabled_at, note, updated_at)
VALUES (
  'photo-intake-storage-record',
  unixepoch(),
  'OPE-403 — inbound_emails.photos_stored is written on every photo intake with attachments',
  unixepoch()
)
ON CONFLICT(probe_name) DO NOTHING;

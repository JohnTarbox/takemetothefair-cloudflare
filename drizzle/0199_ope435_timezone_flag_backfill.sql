-- OPE-435 — the backfill OPE-307 shipped without.
--
-- OPE-307 normalized timezone handling AT INGEST and it works: every non-12:00Z
-- start-time cluster has zero rows created since 2026-07-01. But the existing
-- corpus was never normalized, so 97 live events still carried
-- `start_date_timezone_confused` — and a flag that fires on 97 known-stale rows
-- trains operators to ignore the whole `gate_flags` channel, which is precisely
-- what GATE-NOISE existed to prevent.
--
-- Cites docs/bulk-mutation-discipline.md — single-writer · idempotent ·
-- read-back-verified · rollback-planned.
--
-- ---------------------------------------------------------------------------
-- The 97 are TWO different problems, and treating them as one would be wrong
-- ---------------------------------------------------------------------------
--
-- Measured 2026-08-17:
--
--   already at 12:00:00Z   65   the gate CANNOT fire for these
--   off-anchor             32   the gate genuinely re-fires
--
-- `dateLooksTimezoneConfused` (packages/utils/src/event-date-gates.ts) returns
-- false immediately for h=12,m=0,s=0. So for 65 of the 97 the stored
-- `gate_flags` string is simply STALE — a value the gate would not produce
-- today. Rewriting their timestamps would change nothing; only the string needs
-- clearing. For the other 32 the timestamp really is off-anchor, and clearing
-- the string alone would see it re-added on the next write.
--
-- Hence two statements, deliberately separate.
--
-- ---------------------------------------------------------------------------
-- Why normalizing to 12:00:00Z does not lose information
-- ---------------------------------------------------------------------------
--
-- `events.start_date` is a DATE anchor, not a display time: real opening hours
-- live in `event_days.open_time` / `close_time`. Only 8 of the 32 have
-- event_days hours at all, and this migration does not touch that table — so
-- the ticket's "prefer real hours over the anchor" is satisfied by leaving the
-- real hours exactly where they already are.
--
-- The normalization preserves the UTC calendar date and sets the time to the
-- 12:00Z anchor. Verified across all 32 before writing: every row keeps its
-- `date(start_date)`. Noon is deliberately the anchor Eastern-safe choice —
-- 12:00Z is 07:00/08:00 ET, so the ET calendar date matches the UTC date, which
-- is not true of the 00:00Z and 04:00Z rows this fixes.
--
-- The one genuinely ambiguous row is the single 00:00:00Z event, where a naive
-- ET reading would place it on the PREVIOUS day. The gate's own comment
-- (A3/K14) records midnight-UTC as the signature of a date-only ingest that
-- bypassed normalizeEventDate — i.e. the intended date IS the UTC date. So
-- anchoring it preserves intent rather than shifting it.
--
-- `end_date` is deliberately untouched: this gate is about `start_date`, and
-- `end_date_in_past` is a separate flag with its own semantics. Minimum blast
-- radius.
--
-- ---------------------------------------------------------------------------
-- Idempotency and rollback
-- ---------------------------------------------------------------------------
--
-- Both statements are self-limiting: after they run, no row matches their WHERE
-- clause, so a re-run is a no-op. Safe to replay.
--
-- Rollback: there is no undo for the timestamp rewrite beyond a D1 point-in-time
-- restore, which is why the scope is 32 rows whose stored time carried no
-- verified meaning (they were flagged as untrustworthy by the gate itself, and
-- any row with real hours keeps them in event_days). Clearing the flag is
-- trivially reversible — the gate recomputes it on the next write for any row
-- that still deserves it, which is the actual safety property here: this
-- migration cannot hide a REAL timezone defect, because a genuinely confused
-- row gets re-flagged automatically.

-- 1. Normalize the 32 off-anchor rows to the 12:00Z anchor, preserving the UTC
--    calendar date. Scoped to rows the gate has already flagged, so a
--    deliberately-set time on an unflagged row is never touched.
UPDATE events
SET start_date = unixepoch(date(start_date, 'unixepoch') || ' 12:00:00'),
    updated_at = unixepoch()
WHERE status IN ('APPROVED', 'TENTATIVE')
  AND merged_into IS NULL
  AND gate_flags LIKE '%start_date_timezone_confused%'
  AND strftime('%H:%M:%S', start_date, 'unixepoch') <> '12:00:00';

-- 2. Drop `start_date_timezone_confused` from gate_flags on all remaining
--    flagged live rows (now all at the anchor, so the gate will not re-add it).
--    json_each surgery removes ONLY this entry and preserves siblings such as
--    `source_tier_3_aggregator` / `end_date_in_past`; an emptied array becomes
--    NULL rather than a misleading "[]".
--
--    NOTE: this statement deliberately does NOT touch `updated_at`, unlike
--    statement 1. Since OPE-308, `updated_at` is a real change signal — it
--    drives the sitemap's `lastmod` and the conditional-GET validator. The 65
--    flag-only rows have no user-visible change at all; bumping them would tell
--    search engines that 65 pages were modified and needlessly bust their 304s.
--    Statement 1 bumps it because there the stored start_date genuinely moved.
UPDATE events
SET gate_flags = (
      SELECT CASE
               WHEN json_array_length(json_group_array(j.value)) = 0 THEN NULL
               ELSE json_group_array(j.value)
             END
      FROM json_each(events.gate_flags) j
      WHERE j.value <> 'start_date_timezone_confused'
    )
WHERE status IN ('APPROVED', 'TENTATIVE')
  AND merged_into IS NULL
  AND gate_flags LIKE '%start_date_timezone_confused%';

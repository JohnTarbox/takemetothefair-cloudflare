# DQ4 — 9-5 Daily event_days sweep (operator runbook)

**Filed:** 2026-06-08 alongside Dev-Email-2026-06-08 §C. **Owner:** operator-on-call.

## Why this exists

Many `event_days` rows store generic `09:00`/`17:00` because pre-DQ4 ingest paths defaulted those values when the source page didn't expose real hours. The print sheet (PR #400 / PR 3 of this bundle) and the public `/events/<slug>` render those as if they were authoritative. The canonical case in the email: a Saturday-only farmers market that's actually open **7am–1pm Saturdays** stored as **9am–5pm with a daily-looking schedule**.

## What this PR (DQ4) did

- **Schema** — `drizzle/0118` drops NOT NULL on `event_days.open_time` and `event_days.close_time`.
- **Ingest paths** — 5 ingest paths now write NULL + set `events.flagged_for_review=1` instead of fabricating `"10:00"`/`"18:00"` or `"09:00"`/`"17:00"`:
  1. `src/app/api/suggest-event/submit/route.ts` (vendor suggest + inbound-email pipeline)
  2. `src/app/api/admin/import-url/route.ts` (URL import / AI extract)
  3. MCP `create_event_day` / `update_event_day` (admin tools — now accept null)
  4. `scripts/backfill-event-days-from-description.ts` (UX-R1 backfill — DEFAULT_OPEN_TIME / DEFAULT_CLOSE_TIME constants retained as exports for future explicit-evidence callers, but the cadence-expanded path no longer applies them)
- **Render** — `DailyScheduleDisplay` renders **"Hours not yet confirmed"** when both `openTime` and `closeTime` are null. Partial-known (one set, other null) surfaces what's known.

## Sweep — existing 9-5 rows

This is the operator-triage step the email §C2.2 calls out: **bulk-flag for review, then humans fix per source**. The dev side does not mass-UPDATE hours.

### 1. Backup

```bash
npm run db:backup
```

### 2. Audit query (corrected from email — `events.frequency` column does not exist)

The email's audit query references `events.frequency='Daily'`, but no such column exists in the schema. The cadence label "Daily" is derived at render time from `inferCadence()` over the spacing of `event_days` dates ([[src/lib/recurring-display.ts]]). Substitute the actual stored signal: multiple `event_days` rows all at 09:00–17:00.

Run via the Cloudflare D1 MCP tool (`wrangler d1 execute --remote` is blocked by the auto-mode classifier per [[feedback_prod_d1_blocked_via_wrangler]]):

```sql
SELECT events.id, events.name, events.start_date, events.end_date,
       COUNT(*) AS n_days
FROM event_days
JOIN events ON event_days.event_id = events.id
WHERE event_days.open_time = '09:00'
  AND event_days.close_time = '17:00'
  AND events.status = 'APPROVED'
GROUP BY events.id
HAVING COUNT(*) >= 2
ORDER BY n_days DESC, events.name;
```

Expected size: dozens to a few hundred per email §C1. Cross-reference results against market / fair / festival categories; markets in particular tend to have specific weekday-only short windows (Saturday 7–1, Sunday 9–2, weekday-evening 5–9) — none of which are 9–5.

### 3. Bulk-flag for triage (not bulk-fix)

```sql
UPDATE events
SET flagged_for_review = 1, updated_at = unixepoch()
WHERE id IN (
  SELECT DISTINCT events.id
  FROM event_days
  JOIN events ON event_days.event_id = events.id
  WHERE event_days.open_time = '09:00'
    AND event_days.close_time = '17:00'
    AND events.status = 'APPROVED'
  GROUP BY events.id
  HAVING COUNT(*) >= 2
);
```

Operators see the flagged events at **<https://meetmeatthefair.com/admin/events?flagged=1>**.

### 4. Per-event triage workflow (operator)

For each flagged event:

1. Open the source page (organizer site, aggregator listing) for the event.
2. Find the actual hours (read the schedule section / poster / FAQ).
3. Open `/admin/events/<id>/edit` and update `event_days` rows to the real hours. (The MCP `update_event_day` tool accepts the same args if you'd rather drive from a transcript.)
4. Clear the `flagged_for_review` flag once hours are confirmed.

If the source doesn't expose hours either, leave them null. The render layer surfaces "Hours not yet confirmed" — honest and accurate, vs the fabricated 9-5.

## Acceptance (per email §C3)

- Audit query returns ≥ 1 row pre-sweep; size noted in PR #406 description.
- Canonical Saturday market appears in audit output, gets flagged, operator fixes hours, public `/events/<slug>` renders the real schedule.
- Future ingest verification:
  - Hit `/api/admin/import-url/extract` with a synthetic page that has no times → confirm DB row carries NULL hours + parent `events.flagged_for_review=1`.
  - Render fallback: pick one already-flagged event in dev DB, NULL out its event_days hours, confirm `/events/<slug>` renders "Hours not yet confirmed" instead of crashing on `:`.

## Related

- [[project_event_recurrence_backfill]] — UX-R1 backfill that pre-DQ4 wrote 9-5 defaults; now writes NULL + flag.
- [[feedback_spec_correction_via_code_verification]] — pattern of correcting spec wording against actual schema.
- [[project_event_insert_paths]] — five routes insert into `events` / `event_days`; lifecycle hooks must touch all five.

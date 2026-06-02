#!/usr/bin/env npx tsx
/**
 * UX-R1 / C1 backfill (analyst 2026-06-01 EVE).
 *
 * Populates event_days for APPROVED events that have discontinuous_dates=1
 * but no event_days rows AND a span > 30 days — the "long-span recurring
 * event with no per-day rows" gap that PR #295's RRULE emission can't fix
 * by itself because the underlying data is missing.
 *
 * For each candidate:
 *   1. Call expandCadence(description, {windowStart, windowEnd}) — the
 *      existing K7 helper at src/lib/url-import/cadence-expander.ts that
 *      detects "every Friday", "every Saturday", "1st Friday of every
 *      month", "every other Saturday", and explicit date lists.
 *   2. If returns ≥2 dates → INSERT event_days rows, one per date.
 *      openTime/closeTime default to "09:00"/"17:00" if not derivable.
 *   3. If returns [] → UPDATE flagged_for_review=1 so the row queues for
 *      operator triage at /admin/events?flagged=1.
 *
 * The .ics export (src/components/events/AddToCalendar.tsx:101-110) already
 * branches on eventDays.length to emit one VEVENT per day when populated.
 * So this script fixes the export by populating the data — zero changes
 * needed to the export code.
 *
 * Usage:
 *   npx tsx scripts/backfill-event-days-from-description.ts                  # dry-run, prod
 *   npx tsx scripts/backfill-event-days-from-description.ts --apply          # write to prod
 *   npx tsx scripts/backfill-event-days-from-description.ts --local          # dry-run, local
 *   npx tsx scripts/backfill-event-days-from-description.ts --local --apply  # write to local
 *
 * Per [[feedback_db_backup_before_destructive]]: run `npm run db:backup`
 * before --apply against prod. Per [[feedback_d1_batch_param_limit]]: D1
 * batch param cap is 100/statement — this script INSERTs one event_days
 * row at a time (7 params each) to stay well below.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expandCadence } from "../src/lib/url-import/cadence-expander";

const DB_NAME = "takemetothefair-db";
const DEFAULT_OPEN_TIME = "09:00";
const DEFAULT_CLOSE_TIME = "17:00";

/**
 * Guard against expandCadence's single-weekday capture producing partial
 * data for multi-weekday patterns. The cadence-expander helper's own
 * comment says "every Tuesday and Thursday" is out of scope, but the
 * `/every <weekday>/` regex still matches the first weekday and silently
 * enumerates only that one. That's worse than no data — it would publish
 * a Tuesday-only schedule for an event that actually runs Tue+Thu.
 *
 * This regex catches the common two-weekday phrasing — "Tuesday and
 * Thursday", "Saturdays and Sundays", "Mon and Wed" — so the script
 * flags the event for review rather than accepting the partial cadence.
 */
const MULTI_WEEKDAY_PATTERN =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s+(?:and|&)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i;

interface CandidateRow {
  id: string;
  name: string;
  description: string | null;
  start_date: number; // seconds-epoch
  end_date: number; // seconds-epoch
}

function runD1(sql: string, remote: boolean): unknown[] {
  const args = [
    "wrangler",
    "d1",
    "execute",
    DB_NAME,
    remote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ];
  const out = execFileSync("npx", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  return (parsed[0]?.results ?? []) as unknown[];
}

function quote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Seconds-epoch → YYYY-MM-DD in UTC (matching how event_days dates are stored). */
function epochToYmd(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function main() {
  const apply = process.argv.includes("--apply");
  const local = process.argv.includes("--local");
  const remote = !local;

  console.log(`[backfill] target=${remote ? "PROD" : "LOCAL"} mode=${apply ? "APPLY" : "DRY-RUN"}`);

  // Select candidates. Same shape as the prod count query we ran during
  // planning (12 candidates against prod 2026-06-01 EVE).
  const rows = runD1(
    `SELECT e.id, e.name, e.description, e.start_date, e.end_date
     FROM events e
     WHERE e.discontinuous_dates = 1
       AND e.status = 'APPROVED'
       AND NOT EXISTS (SELECT 1 FROM event_days ed WHERE ed.event_id = e.id)
       AND (julianday(e.end_date, 'unixepoch') - julianday(e.start_date, 'unixepoch')) > 30
     ORDER BY (e.end_date - e.start_date) DESC`,
    remote
  ) as CandidateRow[];

  console.log(`[backfill] ${rows.length} candidate event(s) found`);
  if (rows.length === 0) return;

  let expandedCount = 0;
  let flaggedCount = 0;
  let totalDaysInserted = 0;
  const expandedDetails: Array<{ name: string; dayCount: number }> = [];
  const flaggedDetails: string[] = [];

  for (const row of rows) {
    const windowStart = epochToYmd(row.start_date);
    const windowEnd = epochToYmd(row.end_date);
    const description = row.description ?? "";

    // Pre-check: refuse multi-weekday patterns. expandCadence would match
    // the first weekday only and silently enumerate just that one — worse
    // than no data because the event actually runs on both days.
    const multiWeekdayMatch = description.match(MULTI_WEEKDAY_PATTERN);
    if (multiWeekdayMatch) {
      flaggedCount += 1;
      flaggedDetails.push(row.name);
      console.log(
        `  ⚑ "${row.name}" — multi-weekday pattern detected ("${multiWeekdayMatch[0]}"), ${apply ? "FLAGGING" : "would flag"} for review`
      );
      if (apply) {
        const sql = `UPDATE events SET flagged_for_review = 1, updated_at = unixepoch() WHERE id = ${quote(row.id)}`;
        runD1(sql, remote);
      }
      continue;
    }

    const dates = expandCadence(description, { windowStart, windowEnd });

    if (dates.length >= 2) {
      expandedCount += 1;
      totalDaysInserted += dates.length;
      expandedDetails.push({ name: row.name, dayCount: dates.length });
      console.log(`  ✓ "${row.name}" — ${dates.length} day(s) expanded from cadence`);

      if (apply) {
        // One INSERT per day — keeps each statement at 7 bound-equivalent
        // values, well under the D1 100-param cap. Slower than batching but
        // simpler error handling and within tolerance for ~50-200 rows total.
        for (const date of dates) {
          const id = randomUUID();
          const sql = `INSERT INTO event_days (id, event_id, date, open_time, close_time, notes, closed, vendor_only, created_at) VALUES (${quote(id)}, ${quote(row.id)}, ${quote(date)}, ${quote(DEFAULT_OPEN_TIME)}, ${quote(DEFAULT_CLOSE_TIME)}, ${quote("backfilled from description (UX-R1, 2026-06-01)")}, 0, 0, unixepoch())`;
          runD1(sql, remote);
        }
      }
    } else {
      flaggedCount += 1;
      flaggedDetails.push(row.name);
      console.log(
        `  ⚑ "${row.name}" — no cadence pattern matched, ${apply ? "FLAGGING" : "would flag"} for review`
      );

      if (apply) {
        const sql = `UPDATE events SET flagged_for_review = 1, updated_at = unixepoch() WHERE id = ${quote(row.id)}`;
        runD1(sql, remote);
      }
    }
  }

  console.log("");
  console.log(`[backfill] summary:`);
  console.log(`  candidates:       ${rows.length}`);
  console.log(
    `  cadence-expanded: ${expandedCount} event(s), ${totalDaysInserted} event_days row(s)`
  );
  console.log(`  flagged-for-review: ${flaggedCount} event(s)`);
  if (!apply) {
    console.log(`  (dry-run — re-run with --apply to commit changes)`);
  }
}

main();

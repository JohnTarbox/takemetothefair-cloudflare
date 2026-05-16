#!/usr/bin/env npx tsx
/**
 * Retroactive audit for the date-quality gates rolled out in PR (analyst
 * backlog item #1, 2026-05-16). Scans existing APPROVED events for the
 * failure patterns the gates would have caught at ingest. Outputs a TSV
 * for manual admin review — non-destructive; admin uses the lifecycle
 * endpoint (or update_event MCP tool) to fix any flagged rows.
 *
 * Usage:
 *   npx tsx scripts/audit-event-date-patterns.ts --remote  # against prod
 *   npx tsx scripts/audit-event-date-patterns.ts --local   # against local D1
 *
 * Redirect to a file for review:
 *   npx tsx scripts/audit-event-date-patterns.ts --remote > audit.tsv
 *
 * The script runs SELECT-only via the wrangler CLI — no cross-service auth
 * needed. Verify the active Cloudflare account first (CLAUDE.md mandate):
 *   npx wrangler whoami
 */

import { execFileSync } from "node:child_process";
import {
  evaluateGates,
  nameMatchesAdminFlag,
  dateLooksImplausible,
  sourceCredibilityTier,
} from "@takemetothefair/utils";

interface EventRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  start_date: number | null;
  end_date: number | null;
  source_name: string | null;
  source_url: string | null;
  description: string | null;
}

function parseArgs(argv: string[]) {
  const args = new Set(argv.slice(2));
  return {
    remote: args.has("--remote"),
    local: args.has("--local"),
  };
}

/** Execute a wrangler d1 query without a shell. execFile bypasses /bin/sh
 *  so the query string can't be interpreted as shell metacharacters. */
function dbExec(query: string, opts: { remote: boolean }): EventRow[] {
  const args = [
    "wrangler",
    "d1",
    "execute",
    "takemetothefair-db",
    opts.remote ? "--remote" : "--local",
    "--json",
    "--command",
    query,
  ];
  const out = execFileSync("npx", args, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
  const parsed = JSON.parse(out) as unknown;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const results = (first as { results?: EventRow[] } | null)?.results;
  return results ?? [];
}

function isoOrNull(seconds: number | null): string | null {
  if (seconds == null) return null;
  // events.start_date / end_date are stored as seconds-epoch
  // (memory: reference_drizzle_timestamp_mode_is_seconds).
  return new Date(seconds * 1000).toISOString();
}

function main() {
  const { remote, local } = parseArgs(process.argv);
  if (!remote && !local) {
    console.error("Usage: audit-event-date-patterns.ts --remote | --local");
    process.exit(2);
  }
  if (remote && local) {
    console.error("Pass exactly one of --remote or --local");
    process.exit(2);
  }

  console.error(`Running audit against ${remote ? "PROD" : "LOCAL"} D1...`);

  // Scope: APPROVED events with start_date set (drift gates depend on it).
  // Pull all fields the gate evaluator needs.
  const events = dbExec(
    `SELECT id, name, slug, status, start_date, end_date,
            source_name, source_url, description
     FROM events
     WHERE status = 'APPROVED' AND start_date IS NOT NULL
     ORDER BY start_date`,
    { remote }
  );

  console.error(`Loaded ${events.length} APPROVED events with start_date set.`);

  // TSV header
  console.log(
    [
      "event_id",
      "slug",
      "name",
      "tier",
      "route",
      "reasons",
      "start_date",
      "end_date",
      "source_url",
    ].join("\t")
  );

  let flagged = 0;
  for (const ev of events) {
    const result = evaluateGates({
      name: ev.name,
      sourceName: ev.source_name,
      sourceUrl: ev.source_url,
      startDate: ev.start_date != null ? new Date(ev.start_date * 1000) : null,
      endDate: ev.end_date != null ? new Date(ev.end_date * 1000) : null,
      applicationDeadline: null, // events table has no application_deadline column today
      description: ev.description,
    });

    // Audit reports everything the live gates WOULD have flagged on ingest.
    // Tier 3 events are flagged even with clean data (the live gates also
    // route Tier 3 to PENDING_REVIEW unconditionally).
    if (result.route === "PENDING_REVIEW") {
      flagged += 1;
      console.log(
        [
          ev.id,
          ev.slug,
          ev.name.replace(/\t/g, " "),
          result.tier,
          result.route,
          result.reasons.join("|"),
          isoOrNull(ev.start_date) ?? "",
          isoOrNull(ev.end_date) ?? "",
          ev.source_url ?? "",
        ].join("\t")
      );
    }
  }

  console.error(
    `\nFlagged ${flagged} of ${events.length} events (${
      events.length === 0 ? "0" : ((100 * flagged) / events.length).toFixed(1)
    }%).`
  );
  console.error("Review the TSV. Recommended next step: import into a spreadsheet,");
  console.error("eyeball each flagged row, then use the lifecycle PATCH endpoint or");
  console.error("MCP update_event tool to correct the suspects.");

  // Surface helper-function references so the linter doesn't complain about
  // the imports — they're used as gate primitives indirectly.
  void nameMatchesAdminFlag;
  void dateLooksImplausible;
  void sourceCredibilityTier;
}

main();

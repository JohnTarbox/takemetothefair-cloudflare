#!/usr/bin/env npx tsx
/**
 * Backfill ticket_url / application_url contamination using the same gate
 * the live ingestion path uses (src/lib/url-classification.ts:gateUrlForField).
 * Same logic ⇒ no drift between the prevention and the cleanup.
 *
 * Usage:
 *   npx tsx scripts/backfill-ticket-urls.ts                    # dry-run, prod (default)
 *   npx tsx scripts/backfill-ticket-urls.ts --apply            # write to prod
 *   npx tsx scripts/backfill-ticket-urls.ts --local            # dry-run, local D1
 *   npx tsx scripts/backfill-ticket-urls.ts --local --apply    # write to local D1
 *
 * Reads via `wrangler d1 execute` rather than direct sqlite so it works
 * against prod without exposing remote DB credentials separately.
 */

import { execFileSync } from "node:child_process";
import {
  extractDomain,
  gateUrlForField,
  type ClassificationMap,
} from "../src/lib/url-classification";

const DB_NAME = "takemetothefair-db";

interface ClassificationRow {
  domain: string;
  use_as_ticket_url: number;
  use_as_application_url: number;
  use_as_source: number;
}

interface EventRow {
  id: string;
  slug: string;
  name: string;
  ticket_url: string | null;
  application_url: string | null;
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
  // wrangler emits a JSON array of result-sets; we only ever run one statement
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  return (parsed[0]?.results ?? []) as unknown[];
}

function quote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function main() {
  const apply = process.argv.includes("--apply");
  const local = process.argv.includes("--local");
  const remote = !local;

  console.log(`[backfill] target=${remote ? "PROD" : "LOCAL"} mode=${apply ? "APPLY" : "DRY-RUN"}`);

  // 1. Load classifications
  const classifyRows = runD1(
    "SELECT domain, use_as_ticket_url, use_as_application_url, use_as_source FROM url_domain_classifications;",
    remote
  ) as ClassificationRow[];
  const classifications: ClassificationMap = new Map();
  for (const r of classifyRows) {
    classifications.set(r.domain, {
      useAsTicketUrl: r.use_as_ticket_url === 1,
      useAsApplicationUrl: r.use_as_application_url === 1,
      useAsSource: r.use_as_source === 1,
    });
  }
  console.log(`[backfill] loaded ${classifications.size} classifications`);

  // 2. Load all events with at least one populated URL field
  const events = runD1(
    "SELECT id, slug, name, ticket_url, application_url FROM events WHERE ticket_url IS NOT NULL OR application_url IS NOT NULL;",
    remote
  ) as EventRow[];
  console.log(`[backfill] scanned ${events.length} events with populated URL fields`);

  // 3. Compute affected rows using the SAME helper the ingestion gate uses
  const affected: Array<{
    row: EventRow;
    newTicket: string | null;
    newApplication: string | null;
    reason: string;
  }> = [];

  for (const row of events) {
    const newTicket = gateUrlForField(row.ticket_url, "ticket", classifications);
    const newApplication = gateUrlForField(row.application_url, "application", classifications);
    const ticketChanged = (row.ticket_url ?? null) !== (newTicket ?? null);
    const applicationChanged = (row.application_url ?? null) !== (newApplication ?? null);
    if (!ticketChanged && !applicationChanged) continue;

    const reasonParts: string[] = [];
    if (ticketChanged) {
      const d = extractDomain(row.ticket_url);
      reasonParts.push(`ticket: ${d ?? "<unparseable>"} → ${newTicket ? "kept" : "NULL"}`);
    }
    if (applicationChanged) {
      const d = extractDomain(row.application_url);
      reasonParts.push(
        `application: ${d ?? "<unparseable>"} → ${newApplication ? "kept" : "NULL"}`
      );
    }

    affected.push({ row, newTicket, newApplication, reason: reasonParts.join("; ") });
  }

  console.log(`[backfill] would update ${affected.length} rows`);

  // Group by reason for a quick summary
  const byDomain = new Map<string, number>();
  for (const a of affected) {
    const d = extractDomain(a.row.ticket_url) ?? extractDomain(a.row.application_url) ?? "unknown";
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }
  const summary = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);
  console.log("\n[backfill] breakdown by domain:");
  for (const [domain, count] of summary) {
    console.log(`  ${count.toString().padStart(4)}  ${domain}`);
  }

  // Show the first 10 affected rows for sanity
  console.log("\n[backfill] sample (first 10):");
  for (const a of affected.slice(0, 10)) {
    console.log(`  ${a.row.slug}`);
    console.log(`    ${a.reason}`);
  }

  if (!apply) {
    console.log(
      `\n[backfill] DRY-RUN complete. Re-run with --apply${local ? " --local" : ""} to write changes.`
    );
    return;
  }

  // 4. Apply — UPDATE one row at a time. Use parameterized statements via
  // SET ... WHERE id = '...', escaping single quotes in any text field.
  console.log("\n[backfill] applying updates...");
  let done = 0;
  for (const a of affected) {
    const setTicket = a.newTicket === null ? "NULL" : quote(a.newTicket);
    const setApplication = a.newApplication === null ? "NULL" : quote(a.newApplication);
    const sql = `UPDATE events SET ticket_url = ${setTicket}, application_url = ${setApplication}, updated_at = (unixepoch() * 1000) WHERE id = ${quote(a.row.id)};`;
    runD1(sql, remote);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${affected.length}...`);
  }
  console.log(`\n[backfill] APPLIED: updated ${done} rows.`);
}

main();

/**
 * OPE-575 — `recommendations-scan` died on its own step timeout 14 times.
 *
 * ## What the failure actually was
 *
 * The logged `Execution timed out after 300000ms` is **300s = the workflow's
 * `step.do({ timeout: "5 minutes" })`**, not the Workers execution ceiling the
 * ticket named. The workflow already chunks, already persists a resume cursor
 * in `recommendation_scan_state`, and already reports slow rules — so scope
 * items 2 and 3 were done before this ticket was filed.
 *
 * The cause is rule drift, and the existing instrument had been naming it for a
 * month. From `error_logs` source `…:slow-rule`:
 *
 *   stubs_ready_for_enrichment      212,024 ms
 *   vendors_no_description          148,640 ms
 *   events_legacy_gate_candidates  ~211,000 ms
 *
 * Any two in one chunk exceeds 300s. The scan route's own header records the
 * same failure being patched in May by lowering the chunk 8 -> 3 because
 * "chunk=3 almost guarantees at most one fetch-heavy rule per chunk" — and the
 * workflow then asked for `chunk=4`, overriding it.
 *
 * A count-based bound must be re-tuned every time a rule gets slower, and
 * nothing notices until the step dies again. So the bound is now wall-clock.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
import { recommendationRules } from "@/lib/db/schema";
import { is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { scanAll, SCAN_TIME_BUDGET_MS, type RuleDefinition } from "../engine";

let raw: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

beforeEach(() => {
  raw = new Database(":memory:");
  // EVERY table, generated from the schema.
  //
  // `scanAll` registers rules, builds a canonical-path checker and runs
  // arbitrary rule bodies, so its table surface is not knowable up front —
  // naming them one at a time produced three consecutive "no such table"
  // failures (events, then venues, …). Generating the whole schema is both
  // cheaper to write and immune to a rule later touching one more table.
  for (const t of Object.values(schema)) {
    if (is(t, SQLiteTable)) raw.exec(ddlFor(t as never));
  }
  db = drizzle(raw, { schema });
});

/** A rule that burns `ms` of wall clock and matches nothing. */
function slowRule(ruleKey: string, ms: number): RuleDefinition {
  return {
    ruleKey,
    title: ruleKey,
    description: ruleKey,
    severity: "info",
    run: async () => {
      const until = Date.now() + ms;
      // Busy-wait: the budget is wall-clock, and a fake timer would not
      // reproduce the condition — the real rules are slow on I/O, not on a
      // timer we control.
      while (Date.now() < until) {
        /* spin */
      }
      return [];
    },
  } as unknown as RuleDefinition;
}

describe("the scan stops at a wall-clock budget", () => {
  it("consumes fewer rules than it was given when the budget runs out", async () => {
    // The prod shape in miniature: two slow rules in one chunk. With a
    // count-based bound both run and the caller blows its step timeout.
    const defs = [slowRule("slow-a", 120), slowRule("slow-b", 120), slowRule("slow-c", 120)];
    const res = await scanAll(db as never, defs, { deadlineMs: 100 });

    expect(res.rulesConsumed).toBeLessThan(defs.length);
    expect(res.rulesConsumed).toBeGreaterThan(0);
  });

  it("ALWAYS runs at least one rule, even if it alone exceeds the budget", async () => {
    // ⚠️ The condition that would otherwise deadlock the cursor. If a rule
    // slower than the whole budget were skipped, the cursor would never
    // advance past it and it would never be scanned again — a permanent hole
    // that looks exactly like a healthy scan.
    // ⚠️ `deadlineMs: 0` — an ALREADY-EXPIRED budget. An earlier version passed
    // 10ms, and less than 10ms elapses before the first rule, so the guard was
    // never reached and the mutant that drops it survived. The condition to
    // reproduce is "the budget is spent when the loop starts", not "the budget
    // is small".
    const res = await scanAll(db as never, [slowRule("very-slow", 80)], { deadlineMs: 0 });
    expect(res.rulesConsumed).toBe(1);
  });

  it("consumes everything when the rules fit", async () => {
    // The common case must be unchanged — 23 fast rules should still complete
    // in one call, not dribble out one per cron.
    const defs = [slowRule("a", 1), slowRule("b", 1), slowRule("c", 1)];
    const res = await scanAll(db as never, defs, { deadlineMs: 60_000 });
    expect(res.rulesConsumed).toBe(3);
  });

  it("counts a DISABLED rule as consumed", async () => {
    // The cursor indexes the full rule list. If a disabled rule did not
    // advance it, that rule would be re-offered on every run forever and the
    // cycle would never complete.
    await db.insert(recommendationRules).values({
      id: "r-off",
      ruleKey: "disabled-one",
      title: "disabled-one",
      description: "d",
      severity: "info",
      enabled: false,
    } as never);

    const res = await scanAll(db as never, [slowRule("disabled-one", 1)], { deadlineMs: 60_000 });
    expect(res.rulesConsumed).toBe(1);
    expect(res.scannedRules).toBe(0); // it did not actually run
  });

  it("the default budget leaves real headroom under the 300s step timeout", () => {
    // Checked as a relationship, not a magic number: the budget is compared
    // BETWEEN rules, so the worst case is budget + slowest single rule. The
    // slowest observed in prod is ~212s, so the budget must be well under 300s
    // for that to still fit.
    expect(SCAN_TIME_BUDGET_MS).toBeLessThanOrEqual(150_000);
    expect(SCAN_TIME_BUDGET_MS).toBeGreaterThan(30_000);
  });
});

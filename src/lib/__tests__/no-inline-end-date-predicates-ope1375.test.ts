/**
 * OPE-1375 guard — no inline `gte/gt/lte/lt(events.endDate, …)` outside the
 * shared helper (packages/db-schema/src/event-end-predicates.ts).
 *
 * An inline `gte(events.endDate, now)` drops an event from "upcoming" at
 * 08:00 ET on its own last day (dates are anchored at noon UTC) and drops every
 * NULL-end event; `lt(events.endDate, now)` lists it as "past" at the same
 * instant. Use `upcomingEndPredicate(now)` / `pastEndPredicate(now)`.
 *
 * The guard keys on the ACT — any drizzle comparison of `events.endDate` —
 * not on the argument spelling (`now`, `new Date()`, `nowDate`…), so a new
 * spelling of "now" can't slip past. Comparisons against a genuine window
 * bound (not "now") are listed in ALLOWED with the reason; adding one there is
 * a reviewed decision.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["src", "mcp-server/src", "packages"];
const HELPER = "packages/db-schema/src/event-end-predicates.ts";

/** `file` + the exact matched call text → why it is not an upcoming/past test. */
const ALLOWED: Record<string, string> = {
  "src/lib/recommendations/rules/confirm-past-event-occurrence.ts::lt(events.endDate, upperBound)":
    "a bounded window of recently-ended events, not the upcoming/past boundary",
  "src/lib/recommendations/rules/confirm-past-event-occurrence.ts::gt(events.endDate, lowerBound)":
    "lower bound of the same window",
  "src/app/admin/events/calendar/page.tsx::gte(events.endDate, windowStart)":
    "admin calendar month window overlap",
  "src/app/api/events/[slug]/same-day/route.ts::gte(events.endDate, anchor.startDate)":
    "date-range overlap with another event",
  "mcp-server/src/email-handlers/photo-intake.ts::gte(events.endDate, lo)":
    "overlap with a photo's capture-date window (already NULL-end aware)",
  "mcp-server/src/tools/public.ts::gte(events.endDate, since)":
    "caller-supplied `since` date-range filter",
};

/**
 * OPE-1396 (DUP5) — raw SQL comparisons slipped past CALL_RE: a literal
 * `events.end_date >= unixepoch('now')` in a subquery string, or
 * `${events.endDate} < ${nowSecs}` inside a sql`` template. Same act, so same
 * guard; keyed on `file::<matched comparison>` like the drizzle calls.
 */
const RAW_ALLOWED: Record<string, string> = {
  "mcp-server/src/events/elapsed-tentative.ts::${events.endDate} < ${nowSecs}":
    "OPE-702 population report: buckets NULL end_date SEPARATELY on purpose (end_date_null)",
  "mcp-server/src/events/elapsed-tentative.ts::${events.endDate} >= ${nowSecs}":
    "same report's still_running bucket (NULL end counted apart)",
  "mcp-server/src/events/elapsed-tentative.ts::${events.endDate} >= ${thirtyDaysAgo}":
    "a 30-day window bound, not the upcoming/past boundary",
  "mcp-server/src/tools/event-window.ts::end_date >= active_from;":
    "tool-parameter DESCRIPTION text, not SQL",
};

const RAW_RE = /(?:\$\{events\.endDate\}|\bend_date)\s*(?:>=|<=|<|>)\s*[^\s)]+/g;

function findRawEndDateComparisons(root: string): { hits: string[]; present: Set<string> } {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(root, d), files);
  const hits: string[] = [];
  const present = new Set<string>();
  for (const f of files) {
    const rel = relative(root, f).split("\\").join("/");
    if (rel === HELPER) continue;
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(RAW_RE)) {
      const key = `${rel}::${m[0].replace(/\s+/g, " ")}`;
      present.add(key);
      if (!(key in RAW_ALLOWED)) hits.push(key);
    }
  }
  return { hits: hits.sort(), present };
}

const CALL_RE = /\b(?:gte|gt|lte|lt)\(\s*events\.endDate\s*,\s*[^)]*\)/g;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** Drop comments so a docblock that QUOTES the old predicate doesn't count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function findInlineEndDateComparisons(root: string): string[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(root, d), files);
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(root, f).split("\\").join("/");
    if (rel === HELPER) continue;
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(CALL_RE)) {
      const call = m[0].replace(/\s+/g, " ").replace("( ", "(");
      const key = `${rel}::${call}`;
      if (!(key in ALLOWED)) hits.push(key);
    }
  }
  return hits.sort();
}

describe("OPE-1375 — events.endDate upcoming/past comparisons go through the shared helper", () => {
  it("finds no inline gte/gt/lte/lt(events.endDate, …) outside the helper", () => {
    expect(findInlineEndDateComparisons(ROOT)).toEqual([]);
  });

  it("every allow-list entry still exists (no stale exemptions)", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
    const present = new Set<string>();
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      const src = stripComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(CALL_RE)) {
        present.add(`${rel}::${m[0].replace(/\s+/g, " ").replace("( ", "(")}`);
      }
    }
    expect(Object.keys(ALLOWED).filter((k) => !present.has(k))).toEqual([]);
  });

  it("finds no raw-SQL end_date comparison outside the helper (OPE-1396)", () => {
    expect(findRawEndDateComparisons(ROOT).hits).toEqual([]);
  });

  it("every raw-SQL allow-list entry still exists (no stale exemptions)", () => {
    const { present } = findRawEndDateComparisons(ROOT);
    expect(Object.keys(RAW_ALLOWED).filter((k) => !present.has(k))).toEqual([]);
  });

  it("the raw scanner matches string SQL and sql`` template shapes", () => {
    const sample = [
      "AND events.end_date >= unixepoch('now')",
      "AND ${events.endDate} >= unixepoch()",
      "${events.endDate} IS NOT NULL AND ${events.endDate} < ${nowSecs}",
    ].join("\n");
    expect(stripComments(sample).match(RAW_RE)?.length).toBe(3);
    expect(
      "// was `end_date < now`".replace(/(^|[^:"'`])\/\/.*$/gm, "$1").match(RAW_RE)
    ).toBeNull();
  });

  it("the scanner actually matches the banned shapes (multi-line, any 'now' spelling)", () => {
    const sample =
      "and(\n  gte(\n    events.endDate,\n    nowDate\n  ),\n  lt(events.endDate, new Date())\n)";
    expect(stripComments(sample).match(CALL_RE)?.length).toBe(2);
    expect(
      "// gte(events.endDate, now)".replace(/(^|[^:"'`])\/\/.*$/gm, "$1").match(CALL_RE)
    ).toBeNull();
  });
});

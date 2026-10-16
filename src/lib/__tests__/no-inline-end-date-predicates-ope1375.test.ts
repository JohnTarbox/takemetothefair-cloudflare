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

  it("the scanner actually matches the banned shapes (multi-line, any 'now' spelling)", () => {
    const sample =
      "and(\n  gte(\n    events.endDate,\n    nowDate\n  ),\n  lt(events.endDate, new Date())\n)";
    expect(stripComments(sample).match(CALL_RE)?.length).toBe(2);
    expect(
      "// gte(events.endDate, now)".replace(/(^|[^:"'`])\/\/.*$/gm, "$1").match(CALL_RE)
    ).toBeNull();
  });
});

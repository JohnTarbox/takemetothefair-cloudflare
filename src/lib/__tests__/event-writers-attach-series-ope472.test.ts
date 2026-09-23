/**
 * OPE-472 (09-23 bounce) — every writer that INSERTs an event must parent it.
 *
 * The bounce found two writers the original fix never reached: the bulk import
 * route (aggregator_import — 65 of 65 rows unparented on 09-23) and the
 * promoter DRAFT route (4 PENDING rows with NULL ingestion_method). Same shape
 * as OPE-408's venue geocode: a NEW writer that does not know the helper
 * exists. So this is keyed on the SET of writers, not on any one of them — the
 * next file that inserts into `events` fails here until it attaches a series.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "mcp-server/src"];
const SKIP = new Set(["node_modules", "__tests__", ".next"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Evidence a writer parents what it inserts: the attach helper, or an explicit seriesId. */
const PARENTS = /attachEventToSeries\(|createOccurrenceForSeries\(|\bseriesId:\s*[^,\n]*[A-Za-z]/;

describe("every events INSERT site attaches a series", () => {
  const writers = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) =>
    /\.insert\(\s*events\s*\)/.test(readFileSync(f, "utf8"))
  );

  it("finds the writers at all (a guard that matches nothing passes vacuously)", () => {
    expect(writers.length).toBeGreaterThanOrEqual(8);
    const names = writers.map((w) => w.replace(process.cwd() + "/", ""));
    expect(names).toContain("src/app/api/admin/import/route.ts");
    expect(names).toContain("src/app/api/promoter/events/draft/route.ts");
  });

  it("each one parents what it inserts", () => {
    const missing = writers
      .filter((f) => !PARENTS.test(readFileSync(f, "utf8")))
      .map((w) => w.replace(process.cwd() + "/", ""));
    expect(missing, `events writers with no series attach: ${missing.join(", ")}`).toEqual([]);
  });
});

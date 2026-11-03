/**
 * OPE-1396 (DUP9) — every writer of `application_deadline` normalizes the date
 * server-side with `normalizeEventDate`, the helper MCP `update_event` already
 * used (OPE-505). The app routes stored `new Date(clientString)`, so a
 * date-picker value of "2026-09-12T00:00:00.000Z" landed at midnight UTC —
 * Sept 11 in Eastern, i.e. the deadline shown a day early.
 *
 * The guard keys on the ACT: any `applicationDeadline` assignment built from
 * `new Date(` in a write path (src/app/api, mcp-server/src).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeEventDate } from "@/lib/event-dates";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["src/app/api", "mcp-server/src"];

// `applicationDeadline:` / `applicationDeadline =` whose value expression (up to
// the next , or ;) contains `new Date(` — spans the multi-line ternary shape.
const RAW_DEADLINE_RE = /\bapplicationDeadline\s*[:=](?!=)[^;,]*?\bnew Date\(/g;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

function findRawDeadlineWrites(): string[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(RAW_DEADLINE_RE)) {
      hits.push(`${relative(ROOT, f).split("\\").join("/")}::${m[0].replace(/\s+/g, " ")}`);
    }
  }
  return hits.sort();
}

describe("OPE-1396 — application_deadline is normalized server-side", () => {
  it("no write path builds applicationDeadline from new Date(...)", () => {
    expect(findRawDeadlineWrites()).toEqual([]);
  });

  it("the scanner matches the shapes the routes used", () => {
    const shapes = [
      "applicationDeadline: data.applicationDeadline ? new Date(data.applicationDeadline) : null,",
      "updateData.applicationDeadline = data.applicationDeadline\n  ? new Date(data.applicationDeadline)\n  : null;",
    ];
    for (const s of shapes) expect(s.match(RAW_DEADLINE_RE)).not.toBeNull();
    expect("applicationDeadline: normalizeEventDate(x),".match(RAW_DEADLINE_RE)).toBeNull();
  });

  it("a date-picker midnight-UTC value is stored at noon UTC (same calendar day in Eastern)", () => {
    expect(normalizeEventDate("2026-09-12T00:00:00.000Z")?.toISOString()).toBe(
      "2026-09-12T12:00:00.000Z"
    );
    expect(normalizeEventDate(null)).toBeNull();
  });
});

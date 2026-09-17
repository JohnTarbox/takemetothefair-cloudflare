/**
 * OPE-516 — every writer that retires a citation uses ONE rule.
 *
 * PR #999 fixed the supersede rule in `create_event_citation`. `update_event`
 * and the goodwill field flip each carried their own copy of the old exact-year
 * bucket, and a correction through `update_event` on 2026-08-24 left a
 * contradicting citation active thirteen hours after the fix merged.
 *
 * Keyed on the ACT, not on the fix: any source file that marks an
 * `eventDataCitations` row `superseded` must call `citationSupersedeScope`. A
 * guard that listed the three known sites would be blind to a fourth.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const TREES = ["src", "mcp-server/src", "packages"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Files that update eventDataCitations AND set state "superseded". */
function supersedingFiles(): string[] {
  const hits: string[] = [];
  for (const tree of TREES) {
    for (const file of walk(join(ROOT, tree))) {
      const src = readFileSync(file, "utf8");
      if (/\.update\(\s*eventDataCitations\s*\)/.test(src) && /state:\s*"superseded"/.test(src)) {
        hits.push(relative(ROOT, file));
      }
    }
  }
  return hits.sort();
}

describe("OPE-516 — one supersede rule for every citation writer", () => {
  it("finds the writers it is guarding (a matcher that matches nothing proves nothing)", () => {
    const files = supersedingFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        "mcp-server/src/tools/admin-citations.ts",
        "mcp-server/src/tools/admin.ts",
        "src/lib/goodwill/flip-event-field.ts",
      ])
    );
  });

  it("every one of them calls citationSupersedeScope", () => {
    // `supersedeScopeFilter` is admin-citations.ts's local alias for it.
    const offenders = supersedingFiles().filter(
      (f) =>
        !/(citationSupersedeScope|supersedeScopeFilter)\s*\(/.test(
          readFileSync(join(ROOT, f), "utf8")
        )
    );
    expect(offenders).toEqual([]);
  });
});

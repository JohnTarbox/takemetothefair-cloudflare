import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * OPE-489 — the guard for the defect that caused the outage.
 *
 * `scheduled()` dispatches on `controller.cron` as a chain of independent `if`
 * blocks, then falls through to a DEFAULT daily batch of ~20 tasks. That shape
 * is only safe while every specific branch ends in `return`. The `30 8 * * *`
 * branch did not, so 08:30 ran its own sweep and then executed the whole daily
 * batch a second time — every day, for two weeks, at ~12 concurrent main-app
 * POSTs a run. It surfaced as "Worker exceeded memory limit." in error_logs at
 * 06:01 AND 08:31, two bursts nobody could explain.
 *
 * A missing `return` is invisible to the type checker and to every runtime test
 * that fires one cron in isolation: the branch does its own work correctly, and
 * the damage is everything that happens AFTER it. So the guard is structural.
 */
const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
  "utf8"
);

/** Extract each `if (controller.cron === "<expr>") { ... }` block body. */
function cronBranches(): { cron: string; body: string }[] {
  const out: { cron: string; body: string }[] = [];
  const re = /if \(controller\.cron === "([^"]+)"\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SRC)) !== null) {
    // Brace-match from the opening `{` so nested blocks are handled.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < SRC.length; i++) {
      if (SRC[i] === "{") depth += 1;
      else if (SRC[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({ cron: m[1], body: SRC.slice(start + 1, i) });
  }
  return out;
}

describe("scheduled() cron dispatch (OPE-489)", () => {
  const branches = cronBranches();

  it("finds the dispatch branches at all (guards against the regex silently rotting)", () => {
    // If the dispatch is ever refactored, this test must fail loudly rather than
    // pass vacuously on zero branches — the failure mode that makes source-level
    // assertions worthless.
    expect(branches.length).toBeGreaterThanOrEqual(5);
    expect(branches.map((b) => b.cron)).toContain("30 8 * * *");
  });

  it.each(cronBranches().map((b) => b.cron))(
    'the "%s" branch returns instead of falling through to the daily batch',
    (cron) => {
      const branch = branches.find((b) => b.cron === cron)!;
      // A top-level `return;` in the branch body — indented one level inside the
      // `if`, i.e. 6 spaces given this file's nesting.
      expect(branch.body).toMatch(/\n {6}return;/);
    }
  );
});

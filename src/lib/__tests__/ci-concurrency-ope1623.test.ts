/**
 * OPE-1623 — CI keeps one live run per branch per trigger.
 *
 * Without a `concurrency` block, every push to main started a full CI run (about
 * 20–30 minutes). On 2026-11-10, 26 quick merges queued 26 runs, 16 of them
 * waiting at peak, and PR CI starved for about an hour. Every one of those runs
 * except the last could only end in a skipped deploy, because the gate ships
 * main's HEAD alone. Cancelling them by hand was refused by the agent permission
 * classifier, so the workflow has to do it.
 *
 * These assertions are the parts a later edit could quietly undo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(__dirname, "..", "..", "..");
const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
};
const deploy = parse(readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8")) as {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
};
const gate = readFileSync(join(ROOT, "scripts/deploy-gate.mjs"), "utf8");

describe("CI concurrency (OPE-1623)", () => {
  it("cancels an older in-flight run on the same ref", () => {
    expect(ci.concurrency?.["cancel-in-progress"]).toBe(true);
  });

  it("keys the group on the ref, so PRs and main never cancel each other", () => {
    expect(ci.concurrency?.group).toContain("${{ github.ref }}");
  });

  it("keys the group on the trigger, so a manual dispatch never cancels push CI", () => {
    expect(ci.concurrency?.group).toContain("${{ github.event_name }}");
  });

  it("leaves the deploy workflow queueing, never cancelling, a deploy in flight", () => {
    // A deploy cut off between the D1 migrations and the Worker upload would
    // leave new schema under old code. That one must never cancel.
    expect(deploy.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("relies on a gate that skips any CI conclusion other than success", () => {
    // A cancelled run still fires workflow_run: completed. The gate must read
    // that as "skip", not "deploy" and not an error.
    expect(gate).toMatch(/if \(run\.conclusion !== "success"\) \{\s*return skip\(/);
  });
});

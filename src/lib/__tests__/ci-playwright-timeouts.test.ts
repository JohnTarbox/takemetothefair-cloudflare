/**
 * OPE-705 — the Playwright steps' timeouts, guarded because the number is
 * measured and the obvious "cleanup" is to lower it again.
 *
 * OPE-484 fixed a 20-30 minute hang on `Install Playwright browsers` by caching
 * the binaries. The timeout then moved rather than went away: on a cache hit the
 * apt SYSTEM libraries still install, because they live in the runner image and
 * not in `~/.cache/ms-playwright`.
 *
 * ── The measurement, and why 5 minutes was wrong ──────────────────────────
 *
 * 20 samples of `Install Playwright system dependencies (cache hit)` taken from
 * SUCCESSFUL runs on 2026-08-31 (`actions/runs/<id>/jobs`), across both the E2E
 * and Smoke jobs:
 *
 *     min 12s · median ~25s · mean 53s · max 275s · 7 of 20 over 60s
 *
 * The limit was 300s. So the slowest PASSING run cleared it by 25 seconds — an
 * 8% margin on a step whose observed spread is more than 20x. It read as a rare
 * flake (0 of the last 100 CI runs failed on it) only because it was squeaking
 * under, not because the tail is improbable.
 *
 * ── Why a test and not just a comment ─────────────────────────────────────
 *
 * "5 minutes is plenty for a 25-second step" is TRUE of the median and is
 * exactly the reasoning that set the limit that failed. A comment does not stop
 * that reasoning being applied again; a failing test does, and it fails with the
 * measurement attached.
 *
 * The cost of the raise is zero on the median path: a step that finishes in 25s
 * does not care what the ceiling is. The budget is spent only on the days the
 * apt mirror is slow, which is precisely when we want it spent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const CI_YML = join(__dirname, "..", "..", "..", ".github", "workflows", "ci.yml");

/** Minutes. Chosen against the measured max of 275s, and matched to the sibling
 *  browsers step so the two cannot drift apart. */
const MIN_TIMEOUT_MINUTES = 10;

interface Step {
  name?: string;
  run?: string;
  "timeout-minutes"?: number;
}

const workflow = parse(readFileSync(CI_YML, "utf8")) as {
  jobs: Record<string, { steps?: Step[] }>;
};

/** Every step that shells out to a Playwright installer, in any job. Keyed on
 *  the COMMAND rather than the step name: a rename must not silently drop a
 *  step out of this guard's view. */
const playwrightInstallSteps = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
  (job.steps ?? [])
    .filter((s) => typeof s.run === "string" && /playwright\s+install/.test(s.run))
    .map((s) => ({ jobName, name: s.name ?? "(unnamed)", timeout: s["timeout-minutes"] }))
);

describe("OPE-705 — Playwright install steps carry an adequate timeout", () => {
  it("finds the install steps (guards against a vacuous pass)", () => {
    // Four today: browsers + deps, in each of the e2e and smoke jobs. If the
    // workflow is restructured and this finds nothing, every assertion below
    // would pass over an empty list.
    expect(playwrightInstallSteps.length).toBeGreaterThanOrEqual(4);
    expect(playwrightInstallSteps.map((s) => s.jobName)).toContain("e2e");
    expect(playwrightInstallSteps.map((s) => s.jobName)).toContain("smoke");
  });

  it("every Playwright install step declares a timeout at all", () => {
    // A step with NO timeout inherits the job's, which is the ambiguous-hang
    // behaviour OPE-484 removed: a reviewer cannot tell a hang from a queue.
    const missing = playwrightInstallSteps
      .filter((s) => typeof s.timeout !== "number")
      .map((s) => `${s.jobName} / ${s.name}`);
    expect(missing, "these would hang without failing").toEqual([]);
  });

  it(`no Playwright install step drops below ${MIN_TIMEOUT_MINUTES} minutes`, () => {
    // The measured max on a SUCCESSFUL run is 275s. Anything at or below 5
    // minutes puts the ceiling inside the observed distribution.
    const tooTight = playwrightInstallSteps
      .filter((s) => typeof s.timeout === "number" && s.timeout < MIN_TIMEOUT_MINUTES)
      .map((s) => `${s.jobName} / ${s.name} = ${s.timeout}m`);
    expect(
      tooTight,
      `Measured on 2026-08-31: median ~25s but max 275s on a run that PASSED, ` +
        `against a 300s limit — a 25s margin. Raising costs nothing on the median ` +
        `path. See OPE-705 before lowering these.`
    ).toEqual([]);
  });

  it("keeps the deps step and the browsers step on the same ceiling", () => {
    // They hit the same apt mirror on the same runners. Letting them diverge is
    // how one of two identical paths gets fixed — this repo's most-repeated
    // defect shape, and the exact mistake made mid-fix on this ticket (the
    // smoke job's deps step was initially left at 5).
    const timeouts = new Set(playwrightInstallSteps.map((s) => s.timeout));
    expect(timeouts.size, `saw ${[...timeouts].join(", ")}`).toBe(1);
  });
});

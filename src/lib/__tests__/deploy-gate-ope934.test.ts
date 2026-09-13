/**
 * OPE-934 — the production deploy gate (`scripts/deploy-gate.mjs`).
 *
 * The positive landmark is a REAL payload: the fixture is trimmed from the last
 * successful push-to-main CI run, so "deploy" below is the verdict on an event
 * GitHub actually sent, not on an object written to pass.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../../../scripts/deploy-gate.mjs";
import realPush from "./fixtures/ci-push-main-run-34664725569.json";

const REPO = "JohnTarbox/takemetothefair-cloudflare";
const MAIN = realPush.workflow_run.head_sha;

function run(overrides: Record<string, unknown>) {
  return { workflow_run: { ...realPush.workflow_run, ...overrides } };
}

function viaWorkflowRun(event: unknown, mainHeadSha: string | null = MAIN) {
  return decide({
    eventName: "workflow_run",
    event,
    repository: REPO,
    ref: "refs/heads/main",
    mainHeadSha,
  });
}

describe("OPE-934 — automatic deploys (workflow_run)", () => {
  it("POSITIVE LANDMARK: the real push-to-main CI run deploys, at its own SHA", () => {
    expect(viaWorkflowRun(realPush)).toEqual({
      decision: "deploy",
      sha: MAIN,
      reason: expect.any(String),
    });
  });

  it("REFUSES a fork PR whose branch is named main — the ticket's attack", () => {
    const fork = run({
      event: "pull_request",
      head_branch: "main",
      head_repository: { full_name: "attacker/takemetothefair-cloudflare" },
    });
    expect(viaWorkflowRun(fork).decision).toBe("skip");
  });

  it("REFUSES a fork whose run even claims to be a push, on the head repository alone", () => {
    // Isolates the head_repository check: every other field is the real push.
    const fork = run({ head_repository: { full_name: "attacker/takemetothefair-cloudflare" } });
    const d = viaWorkflowRun(fork);
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/head repository/);
  });

  it("REFUSES a same-repo pull_request run", () => {
    expect(viaWorkflowRun(run({ event: "pull_request" })).decision).toBe("skip");
  });

  it("REFUSES a push run on another branch", () => {
    expect(viaWorkflowRun(run({ head_branch: "feature" })).decision).toBe("skip");
  });

  it.each(["failure", "cancelled", "timed_out", "skipped", null])("REFUSES conclusion %s", (c) => {
    expect(viaWorkflowRun(run({ conclusion: c })).decision).toBe("skip");
  });

  it("SKIPS a green run whose commit is no longer main's HEAD — the newer run deploys", () => {
    const d = viaWorkflowRun(realPush, "a".repeat(40));
    expect(d.decision).toBe("skip");
    expect(d.reason).toMatch(/newer run deploys/);
  });

  it("REFUSES when main's HEAD could not be resolved", () => {
    expect(viaWorkflowRun(realPush, null).decision).toBe("skip");
    expect(viaWorkflowRun(realPush, "not-a-sha").decision).toBe("skip");
  });

  it("REFUSES a payload with no workflow_run object", () => {
    expect(viaWorkflowRun({}).decision).toBe("skip");
  });
});

describe("OPE-934 — manual deploys (workflow_dispatch)", () => {
  const dispatch = (ref: string) =>
    decide({ eventName: "workflow_dispatch", event: {}, repository: REPO, ref, mainHeadSha: MAIN });

  it("POSITIVE LANDMARK: a dispatch on refs/heads/main deploys main's HEAD", () => {
    expect(dispatch("refs/heads/main")).toMatchObject({ decision: "deploy", sha: MAIN });
  });

  it.each(["refs/heads/feature", "refs/tags/v1", "refs/pull/1/merge", ""])(
    "REFUSES a dispatch on %j",
    (ref) => {
      expect(dispatch(ref).decision).toBe("skip");
    }
  );
});

describe("OPE-934 — the CLI writes what the workflow reads", () => {
  it("emits decision/sha to GITHUB_OUTPUT from the real payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-gate-"));
    const eventPath = join(dir, "event.json");
    const outPath = join(dir, "out.txt");
    writeFileSync(eventPath, JSON.stringify(realPush));
    writeFileSync(outPath, "");
    execFileSync("node", [join(__dirname, "../../../scripts/deploy-gate.mjs")], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: REPO,
        GITHUB_REF: "refs/heads/main",
        MAIN_HEAD_SHA: `${MAIN}\n`,
        GITHUB_OUTPUT: outPath,
      },
    });
    const out = readFileSync(outPath, "utf8");
    expect(out).toContain("decision=deploy\n");
    expect(out).toContain(`sha=${MAIN}\n`);
  });
});

describe("OPE-934 — deploy.yml is actually wired to the gate", () => {
  const yml = readFileSync(join(__dirname, "../../../.github/workflows/deploy.yml"), "utf8");

  it("runs the gate script, and d1-migrate is conditioned on its decision", () => {
    expect(yml).toMatch(/node scripts\/deploy-gate\.mjs/);
    expect(yml).toMatch(/needs\.gate\.outputs\.decision == 'deploy'/);
  });

  it("no job checks out the triggering head_sha directly any more", () => {
    // Landmark: there ARE checkouts to inspect.
    expect((yml.match(/actions\/checkout@/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(yml).not.toMatch(/workflow_run\.head_sha \|\| github\.ref/);
    expect((yml.match(/ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/g) ?? []).length).toBe(3);
  });

  it("keeps the deploy-production concurrency group and the OPE-494 asset carry-forward", () => {
    expect(yml).toMatch(/group: deploy-production/);
    expect(yml).toMatch(/Merge previous build's chunks into this deploy/);
  });
});

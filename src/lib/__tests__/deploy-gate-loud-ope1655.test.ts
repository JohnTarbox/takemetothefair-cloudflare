/**
 * OPE-1655 — a skipped deploy on main's HEAD fails the run instead of reading
 * "success". From 11-13 to 11-16 main's CI was red (OPE-1652); every deploy run
 * skipped all three jobs and stayed green while prod sat on 00f6c96.
 *
 * Uses the same REAL push-to-main payload as the OPE-934 suite, so "loud" is
 * judged against an event GitHub actually sent.
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
const NEWER = "f".repeat(40);

const run = (o: Record<string, unknown>) => ({ workflow_run: { ...realPush.workflow_run, ...o } });
const gate = (
  event: unknown,
  mainHeadSha: string | null = MAIN,
  mainHeadCiConclusion: string | null = null
) =>
  decide({
    eventName: "workflow_run",
    event,
    repository: REPO,
    ref: "refs/heads/main",
    mainHeadSha,
    mainHeadCiConclusion,
  });

describe("OPE-1655 — which skips are loud", () => {
  it("POSITIVE LANDMARK: a green run on HEAD deploys and is not loud", () => {
    expect(gate(realPush)).toMatchObject({ decision: "deploy", loud: false });
  });

  it("LOUD: the 11-13 shape — our push-to-main CI for HEAD concluded failure", () => {
    expect(gate(run({ conclusion: "failure" }))).toEqual({
      decision: "skip",
      sha: null,
      reason: "CI concluded failure",
      loud: true,
    });
  });

  it.each(["cancelled", "timed_out", "action_required"])("LOUD: HEAD's CI %s", (conclusion) => {
    expect(gate(run({ conclusion })).loud).toBe(true);
  });

  it("LOUD: main's HEAD could not be resolved (no deploy can happen)", () => {
    expect(gate(realPush, null)).toMatchObject({ decision: "skip", loud: true });
  });

  it("QUIET: a superseded run — red or cancelled, but main has moved on (the newer run deploys or fails)", () => {
    expect(gate(run({ conclusion: "cancelled" }), NEWER)).toMatchObject({
      decision: "skip",
      loud: false,
    });
    expect(gate(run({ conclusion: "failure" }), NEWER)).toMatchObject({
      decision: "skip",
      loud: false,
    });
    // A green-but-stale run whose newer HEAD is not finished is quiet too.
    expect(gate(realPush, NEWER, null)).toMatchObject({ decision: "skip", loud: false });
  });

  it("QUIET: red runs that were never a main deploy (PR, fork, other branch)", () => {
    expect(gate(run({ conclusion: "failure", event: "pull_request" })).loud).toBe(false);
    expect(gate(run({ conclusion: "failure", head_branch: "feature" })).loud).toBe(false);
    expect(
      gate(run({ conclusion: "failure", head_repository: { full_name: "attacker/x" } })).loud
    ).toBe(false);
  });

  it("CLI writes loud=true to GITHUB_OUTPUT for a red HEAD", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-loud-"));
    const eventPath = join(dir, "event.json");
    const outPath = join(dir, "out.txt");
    writeFileSync(eventPath, JSON.stringify(run({ conclusion: "failure" })));
    writeFileSync(outPath, "");
    execFileSync("node", [join(__dirname, "../../../scripts/deploy-gate.mjs")], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: REPO,
        GITHUB_REF: "refs/heads/main",
        MAIN_HEAD_SHA: MAIN,
        GITHUB_OUTPUT: outPath,
      },
    });
    const out = readFileSync(outPath, "utf8");
    expect(out).toContain("decision=skip\n");
    expect(out).toContain("loud=true\n");
    expect(out).toContain("reason=CI concluded failure\n");
  });
});

describe("OPE-1655 — deploy.yml fails the run on a loud skip", () => {
  const yml = readFileSync(join(__dirname, "../../../.github/workflows/deploy.yml"), "utf8");
  const job = yml.slice(yml.indexOf("  skipped-deploy-alarm:"), yml.indexOf("  d1-migrate:"));

  it("exposes loud + reason from the gate", () => {
    expect(yml).toMatch(/loud: \$\{\{ steps\.decide\.outputs\.loud \}\}/);
    expect(yml).toMatch(/reason: \$\{\{ steps\.decide\.outputs\.reason \}\}/);
  });

  it("has an alarm job gated on a LOUD skip that writes the summary line and exits 1", () => {
    expect(job.length).toBeGreaterThan(200); // landmark: the job block was found
    expect(job).toMatch(/needs: gate/);
    expect(job).toMatch(
      /if: needs\.gate\.outputs\.decision == 'skip' && needs\.gate\.outputs\.loud == 'true'/
    );
    expect(job).toMatch(
      /Deploy skipped: CI for \$\{SHA:0:8\} was \$\{CONCLUSION:-unknown\}; prod is still/
    );
    expect(job).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(job).toMatch(/\n\s+exit 1\n/);
  });

  it("stamps the main app's build SHA so /api/health can name it", () => {
    expect(yml).toMatch(
      /command: deploy --var GIT_SHA:\$\{\{ steps\.vars\.outputs\.git_sha \}\}\n/
    );
  });
});

#!/usr/bin/env node
/**
 * OPE-934 — who is allowed to reach production.
 *
 * `deploy.yml` runs on `workflow_run` of CI with `branches: [main]`, and GitHub
 * matches that filter against the triggering run's HEAD BRANCH. CI also runs
 * on `pull_request`. This repository is PUBLIC, forking is allowed, and the
 * fork-PR approval policy is `first_time_contributors` (all three read from the
 * GitHub API on 2026-09-13) — so a returning contributor's fork PR whose branch
 * is named `main` produces a successful CI run that the old gate admitted,
 * checking out THAT commit and deploying it with the production credentials.
 * A fork PR can also edit ci.yml, so "CI passed" proves nothing about it.
 *
 * The old gate was a job-level `if:` that looked only at the conclusion. An
 * `if:` cannot be tested; this can. Every rule is here, in one pure function.
 *
 * Deliberately dependency-free: it runs before `npm ci`, from a checkout of
 * `main` — never of the triggering commit, whose code is the thing on trial.
 */

/**
 * @typedef {{ decision: "deploy" | "skip", sha: string | null, reason: string }} GateDecision
 */

/**
 * @param {{
 *   eventName: string,
 *   event: any,
 *   repository: string,
 *   ref: string,
 *   mainHeadSha: string | null,
 * }} input
 * @returns {GateDecision}
 */
export function decide({ eventName, event, repository, ref, mainHeadSha }) {
  const skip = (reason) => ({ decision: "skip", sha: null, reason });

  if (!mainHeadSha || !/^[0-9a-f]{40}$/.test(mainHeadSha)) {
    // Every path below needs main's HEAD. Not knowing it is not permission.
    return skip(`could not resolve main's HEAD (got ${JSON.stringify(mainHeadSha)})`);
  }

  if (eventName === "workflow_dispatch") {
    if (ref !== "refs/heads/main") {
      return skip(`manual deploy dispatched on ${ref}; only refs/heads/main may deploy`);
    }
    // Deploy main's HEAD — the ref the operator dispatched on, pinned to a SHA
    // so every job in the run checks out the same commit.
    return { decision: "deploy", sha: mainHeadSha, reason: "manual dispatch on main" };
  }

  if (eventName !== "workflow_run") {
    return skip(`unexpected trigger ${eventName}`);
  }

  const run = event && event.workflow_run;
  if (!run) return skip("workflow_run event carries no workflow_run object");

  if (run.conclusion !== "success") {
    return skip(`CI concluded ${run.conclusion}`);
  }
  if (run.event !== "push") {
    return skip(`CI was triggered by ${run.event}, not a push`);
  }
  if (run.head_branch !== "main") {
    return skip(`CI ran on branch ${run.head_branch}, not main`);
  }
  const headRepo = run.head_repository && run.head_repository.full_name;
  if (headRepo !== repository) {
    return skip(`CI head repository ${headRepo} is not ${repository}`);
  }
  if (!/^[0-9a-f]{40}$/.test(run.head_sha || "")) {
    return skip(`CI head_sha ${JSON.stringify(run.head_sha)} is not a commit SHA`);
  }
  if (run.head_sha !== mainHeadSha) {
    // Two merges close together: this run's commit is no longer main. Deploying
    // it now could land AFTER the newer one and leave production behind. The
    // newer commit's own CI run will deploy.
    return skip(
      `CI tested ${run.head_sha.slice(0, 8)} but main is now ${mainHeadSha.slice(0, 8)}; the newer run deploys`
    );
  }
  return {
    decision: "deploy",
    sha: run.head_sha,
    reason: "green push-to-main CI run on main's HEAD",
  };
}

// ── CLI: `node scripts/deploy-gate.mjs` inside the gate job. ──────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const fs = await import("node:fs");
  const env = process.env;
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const result = decide({
    eventName: env.GITHUB_EVENT_NAME ?? "",
    event,
    repository: env.GITHUB_REPOSITORY ?? "",
    ref: env.GITHUB_REF ?? "",
    mainHeadSha: (env.MAIN_HEAD_SHA ?? "").trim() || null,
  });
  console.log(`[deploy-gate] ${result.decision}: ${result.reason}`);
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      `decision=${result.decision}\nsha=${result.sha ?? ""}\nreason=${result.reason.replace(/\n/g, " ")}\n`
    );
  }
}

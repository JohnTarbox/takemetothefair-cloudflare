/**
 * OPE-726 — a detector nobody calls must not be able to appear silently.
 *
 * This project has shipped the same defect repeatedly: a predicate written,
 * fully tested, and reachable by nothing. `findPriorAdjudication` (13 tests, 13
 * days), OPE-236's claim-recording (present on 3 of 6 paths),
 * `/api/promoter/claim/direct` (0 production executions, no caller).
 *
 * A one-off audit does not fix that — the list regrows. This is the guard.
 *
 * ── What it does NOT claim ────────────────────────────────────────────────
 *
 * The audit that seeded it over-reported, and the reason is recorded here so
 * the next reader does not repeat it: **a thin wrapper counts as uncalled while
 * its implementation is live.** `isNoise` is three lines over `classifyNoise`,
 * which has production callers; the noise filtering it appears to be missing
 * actually runs. Four of the nine tested entries below are that shape.
 *
 * So ALLOWED is not a list of defects. It is a list of exports that no
 * production code calls, each with the reason it is tolerable. The guard's job
 * is only to stop a NEW one joining without that reason being written down.
 *
 * ── Scope, honestly ──────────────────────────────────────────────────────
 *
 * Name-shaped, so it is a floor and not a ceiling: `evaluateThing` is caught,
 * `thingVerdict` is not. Widening the pattern is welcome; narrowing it is how
 * the guard stops working.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const SEARCH_ROOTS = ["src", "mcp-server/src", "packages"];

/** Detector/predicate-shaped export names. */
const NAME_HINT =
  /^(detect|classify|find|is|has|should|check|compute|evaluate|score|violates)[A-Z]/;
const EXPORT_FN = /^export (?:async )?function ([A-Za-z0-9_]+)/gm;

/**
 * Known-uncalled exports, each with the reason it is tolerated.
 *
 * ⚠️ Adding a name here is a deliberate, reviewable claim that nothing needs to
 * call it. Prefer deleting. A reason of "not used yet" is not a reason.
 */
const ALLOWED: Record<string, string> = {
  // ── Thin wrappers whose IMPLEMENTATION is live. Redundant, not missing. ──
  isNoise:
    "3-line wrapper over classifyNoise, which has 2 production callers (faults/candidates route). The noise filter runs.",
  isChallengePage:
    "3-line wrapper over detectChallengePage, which has 5 production callers since OPE-537 (#1133).",
  isHotlinked: "3-line wrapper over classifyImageHost, which has 4 production callers.",
  classifySignature: "Wrapper over classifyFault, which has 3 production callers.",

  // ── Genuinely unreached logic. These are the real audit findings. ────────
  classifyProbe:
    "outbound-link-verdict.ts is unreached; 9 tests. Real finding — wire or delete, see OPE-726.",
  shouldRaise: "Same module as classifyProbe, same status.",
  checkVenueCityPlausibility: "Self-contained, 9 tests, no caller. Real finding — see OPE-726.",
  isTentativeEvent: "Self-contained, 5 tests, no caller. Real finding — see OPE-726.",
  isDiscontinuousWithoutDays: "Self-contained, 4 tests, no caller. Real finding — see OPE-726.",

  // ── Zero tests AND zero callers. Probably dead; not deleted blind. ───────
  isOperatorReplyEnabled:
    "Half of OPE-626's deliberately asymmetric gate pair; its sibling isAutoReplyEnabled IS called. An unused gate is a gate that is not gating — check before deleting.",
  hasQuotedReply: "No caller, no test.",
  hasObligation: "No caller, no test.",
  isVendorRelevantEvent: "No caller, no test.",
  classifyRelevance: "No caller, no test.",
  isHoldExpired: "No caller, no test.",
  isKnownScannerUa: "No caller, no test.",
  findUnstoredPhotoIntakes: "No caller, no test.",
  isExhibitor: "No caller, no test.",
  isSponsor: "No caller, no test.",
  findBrokenLinks: "No caller, no test.",
  isNetworkError: "Error-message helper; no caller.",
  isValidationError: "Error-message helper; no caller.",
  isServerError: "Error-message helper; no caller.",
  isFetchError: "Error-message helper; no caller.",
  isFromCloudProvider: "No caller, no test.",
  hasImage: "No caller, no test.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist" || name.startsWith("."))
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = SEARCH_ROOTS.flatMap((r) => walk(join(ROOT, r))).map((f) => ({
  rel: relative(ROOT, f).replace(/\\/g, "/"),
  src: readFileSync(f, "utf8"),
}));

/** Exported detector-shaped functions, and whether anything calls them. */
const detectors = files.flatMap(({ rel, src }) =>
  [...src.matchAll(EXPORT_FN)]
    .map((m) => m[1])
    .filter((n) => NAME_HINT.test(n))
    .map((name) => {
      // Count call syntax across ALL production files, including the defining
      // one — an internal helper exported for tests is NOT inert. Getting this
      // wrong is what made the first pass of the audit report 93 instead of 26.
      const call = new RegExp(`(?<!function )\\b${name}\\s*\\(`, "g");
      const calls = files.reduce((n, f) => n + (f.src.match(call)?.length ?? 0), 0);
      return { name, rel, calls };
    })
);

describe("OPE-726 — no new inert detector", () => {
  it("finds detectors at all (guards against a vacuous pass)", () => {
    // If the export pattern changes and this matches nothing, every assertion
    // below passes over an empty list.
    expect(detectors.length).toBeGreaterThan(200);
  });

  it("every uncalled detector is on the reviewed list", () => {
    const offenders = detectors
      .filter((d) => d.calls === 0)
      .filter((d) => !(d.name in ALLOWED))
      .map((d) => `${d.rel} :: ${d.name}`);

    expect(
      offenders,
      `These exported detectors have NO production caller. Wire one, delete it, ` +
        `or add it to ALLOWED with a real reason. "Not used yet" is not a reason — ` +
        `this project has shipped fully-tested detectors that nothing called at ` +
        `least three times. See OPE-726.`
    ).toEqual([]);
  });

  it("the reviewed list does not rot — every entry is still uncalled", () => {
    // The other direction. When someone finally wires one up, it must leave the
    // list, or the list stops meaning anything.
    const nowCalled = Object.keys(ALLOWED).filter((name) => {
      const d = detectors.find((x) => x.name === name);
      return d && d.calls > 0;
    });
    expect(nowCalled, `These are now called and should be REMOVED from ALLOWED.`).toEqual([]);
  });

  it("every reason is specific enough to review", () => {
    for (const [name, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(15);
      expect(reason, `${name}: "not used yet" is not a reason`).not.toMatch(
        /^(unused|not used yet|tbd|todo)\.?$/i
      );
    }
  });
});

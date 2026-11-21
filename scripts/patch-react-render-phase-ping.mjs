#!/usr/bin/env node
// OPE-1678 — backport React's render-phase ping fix into the react-dom that Next
// vendors (next/dist/compiled/react-dom*), run from `postinstall`.
//
// THE BUG (react-dom 19.2.0-canary-0bdb9206, vendored by next@15.5.29, the last
// Next 15): `pingSuspendedRoot` has a branch for "the root being rendered right now
// is already RootSuspendedWithDelay". Outside the render phase it restarts the
// render (`prepareFreshStack`). INSIDE the render phase it does nothing at all — it
// neither restarts nor records `workInProgressRootPingedLanes`. When that render
// then finishes suspended, `markRootSuspended` marks the lanes suspended and clears
// `root.pingedLanes`, and the pingCache entry is already deleted, so nothing ever
// pings those lanes again. The transition hangs forever: the URL never changes.
//
// HOW /events HITS IT: a calendar click is a transition. The page segment suspends
// first (exit status 4 = RootSuspendedWithDelay), then a later fiber in the SAME
// render throws a Flight chunk in `resolved_model` state. Attaching the ping
// listener (`wakeable.then(ping)`) initialises that chunk and calls `ping`
// SYNCHRONOUSLY — i.e. during the render phase — and the ping is dropped.
// Measured on a local production build (same build, fix toggled at runtime):
// unfixed 12/15 clicks dropped, all 12 with a render-phase ping at status 4;
// fixed 0/15.
//
// THE FIX is upstream React's own (react-dom 19.3.1 `pingSuspendedRoot`): in the
// render phase, record the pinged lanes so `markRootSuspended` leaves them
// pending and the root is retried.
//
// Remove this script once Next vendors a react-dom with the fix (OPE-1517, Next 16):
// it then reports every target as already fixed and changes nothing.
//
// Guard (OPE-6 v3.8): a target that has NEITHER the buggy NOR the fixed text fails
// the install, so a Next upgrade that moves the code can't turn this into a silent
// no-op. A missing `next` (e.g. a workspace-only install) is skipped with a notice.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compiled = join(root, "node_modules", "next", "dist", "compiled");

// Minified production/profiling builds share one shape; the development builds use
// the named constants.
const PROD = {
  buggy:
    "? 0 === (executionContext & 2) && prepareFreshStack(root, 0)\n      : (workInProgressRootPingedLanes |= pingedLanes),",
  fixed:
    "? 0 === (executionContext & 2)\n        ? prepareFreshStack(root, 0)\n        : (workInProgressRootPingedLanes |= pingedLanes)\n      : (workInProgressRootPingedLanes |= pingedLanes),",
};
const DEV = {
  buggy:
    "? (executionContext & RenderContext) === NoContext &&\n            prepareFreshStack(root, 0)\n          : (workInProgressRootPingedLanes |= pingedLanes),",
  fixed:
    "? (executionContext & RenderContext) === NoContext\n            ? prepareFreshStack(root, 0)\n            : (workInProgressRootPingedLanes |= pingedLanes)\n          : (workInProgressRootPingedLanes |= pingedLanes),",
};

export const TARGETS = [
  ["react-dom/cjs/react-dom-client.production.js", PROD],
  ["react-dom/cjs/react-dom-profiling.profiling.js", PROD],
  ["react-dom/cjs/react-dom-client.development.js", DEV],
  ["react-dom/cjs/react-dom-profiling.development.js", DEV],
  ["react-dom-experimental/cjs/react-dom-client.production.js", PROD],
  ["react-dom-experimental/cjs/react-dom-profiling.profiling.js", PROD],
  ["react-dom-experimental/cjs/react-dom-unstable_testing.production.js", PROD],
  ["react-dom-experimental/cjs/react-dom-client.development.js", DEV],
  ["react-dom-experimental/cjs/react-dom-profiling.development.js", DEV],
  ["react-dom-experimental/cjs/react-dom-unstable_testing.development.js", DEV],
];

const count = (s, needle) => s.split(needle).length - 1;

/** Returns "patched" | "already-fixed"; throws when the file matches neither form. */
export function patchSource(src, { buggy, fixed }, label = "source") {
  if (count(src, fixed) === 1 && count(src, buggy) === 0) return { status: "already-fixed", src };
  const n = count(src, buggy);
  if (n !== 1) {
    throw new Error(
      `${label}: expected exactly 1 copy of the unfixed pingSuspendedRoot branch, found ${n} ` +
        `(and ${count(src, fixed)} of the fixed one). The vendored react-dom changed — check whether ` +
        "it now carries React's own fix (then delete scripts/patch-react-render-phase-ping.mjs and its " +
        "postinstall hook) or re-derive the anchor. See OPE-1678."
    );
  }
  return { status: "patched", src: src.replace(buggy, fixed) };
}

function main() {
  if (!existsSync(compiled)) {
    console.log("[OPE-1678] next is not installed here; render-phase ping patch skipped.");
    return;
  }
  const tally = { patched: 0, "already-fixed": 0 };
  for (const [rel, shape] of TARGETS) {
    const file = join(compiled, rel);
    if (!existsSync(file))
      throw new Error(`[OPE-1678] missing ${rel} — the vendored react-dom layout changed.`);
    const before = readFileSync(file, "utf8");
    const { status, src } = patchSource(before, shape, rel);
    if (status === "patched") writeFileSync(file, src);
    tally[status]++;
  }
  console.log(
    `[OPE-1678] react-dom render-phase ping fix: ${tally.patched} patched, ${tally["already-fixed"]} already fixed, of ${TARGETS.length} files.`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(String(e?.message || e));
    process.exit(1);
  }
}

/**
 * OPE-1678 — the postinstall backport of React's render-phase ping fix.
 *
 * A calendar click on /events is a transition; when a fiber's ping fires
 * synchronously during the render phase while the root is already
 * RootSuspendedWithDelay, the vendored react-dom (19.2.0-canary-0bdb9206 in
 * next@15.5.29) dropped it and the navigation never committed. The script patches
 * the shipped copies under node_modules/next/dist/compiled.
 *
 * Two layers: the pure `patchSource` (patch / idempotence / loud failure), and the
 * INSTALLED tree — which is what the build actually bundles.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { TARGETS, patchSource } from "../../../scripts/patch-react-render-phase-ping.mjs";

const compiled = join(process.cwd(), "node_modules", "next", "dist", "compiled");
const prodShape = TARGETS.find(([rel]) => rel.endsWith("react-dom-client.production.js"))![1];

const wrap = (branch: string) =>
  `function pingSuspendedRoot(root, wakeable, pingedLanes) {\n  workInProgressRoot === root &&\n    (4 === workInProgressRootExitStatus)\n      ${branch}\n  ensureRootIsScheduled(root);\n}`;

describe("patchSource (OPE-1678)", () => {
  it("rewrites the unfixed branch to record pinged lanes in the render phase", () => {
    const out = patchSource(wrap(prodShape.buggy), prodShape);
    expect(out.status).toBe("patched");
    expect(out.src).toContain(prodShape.fixed);
    expect(out.src).not.toContain(prodShape.buggy);
    // The render-phase arm now records the ping instead of doing nothing.
    expect(out.src).toMatch(
      /\? 0 === \(executionContext & 2\)\s*\? prepareFreshStack\(root, 0\)\s*: \(workInProgressRootPingedLanes \|= pingedLanes\)/
    );
  });

  it("is idempotent: an already-fixed source is left byte-identical", () => {
    const once = patchSource(wrap(prodShape.buggy), prodShape).src;
    const twice = patchSource(once, prodShape);
    expect(twice.status).toBe("already-fixed");
    expect(twice.src).toBe(once);
  });

  it("fails loudly when neither form is present (a Next upgrade moved the code)", () => {
    expect(() => patchSource("function pingSuspendedRoot() {}", prodShape, "x.js")).toThrow(
      /OPE-1678/
    );
  });

  it("fails loudly on an ambiguous source with two unfixed copies", () => {
    expect(() => patchSource(wrap(prodShape.buggy) + wrap(prodShape.buggy), prodShape)).toThrow(
      /found 2/
    );
  });
});

describe("installed next/dist/compiled react-dom copies (OPE-1678)", () => {
  it("every target carries the fixed branch and none the unfixed one", () => {
    let examined = 0;
    for (const [rel, shape] of TARGETS) {
      const src = readFileSync(join(compiled, rel), "utf8");
      expect(src.includes(shape.buggy), `${rel} still unfixed — did postinstall run?`).toBe(false);
      expect(src.includes(shape.fixed), `${rel} lacks the fixed branch`).toBe(true);
      examined++;
    }
    // Positive landmark: the loop really examined every copy the client can bundle.
    expect(examined).toBe(10);
  });
});

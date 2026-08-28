/**
 * OPE-613 — the signature key must keep the token that identifies the fault,
 * and must not key on one the bundler renames.
 *
 * `normalizeErrorClass` stripped every quoted literal, so these three real and
 * unrelated client faults
 *
 *   TypeError: null is not an object (evaluating 'b.parentNode')
 *   TypeError: null is not an object (evaluating 'o.id')
 *   TypeError: null is not an object (evaluating 's.id')
 *
 * all collapsed to `typeerror: null is not an object (evaluating )`.
 *
 * Two rows sat at status='noise' under that class — salem (168) and cummington
 * (22) — ruled on 2026-07-17 on evidence specific to `b.parentNode`. So an
 * `.id` fault landing on those routes deduped into a human's decision about a
 * different fault and was never seen again. **A human cannot rule correctly on
 * a key that erased the evidence.**
 *
 * The second defect is the mirror image: `b`, `o`, `s` are bundler-assigned
 * locals. Measured in prod — the same family ran as `o.id` (29 hits, 17 routes,
 * through 08-19) and then as `s.id` (5 hits, 3 routes, from 08-28) across one
 * deploy. A rule keyed on the letter under-matches after a rebuild and, worse,
 * can silently OVER-match a genuine fault that happens to minify to it.
 */
import { describe, it, expect } from "vitest";
import { normalizeErrorClass, classifyNoise, THIRD_PARTY_NOISE_DENYLIST } from "../signature";

const PARENT_NODE = "TypeError: null is not an object (evaluating 'b.parentNode')";
const O_ID = "TypeError: null is not an object (evaluating 'o.id')";
const S_ID = "TypeError: null is not an object (evaluating 's.id')";

describe("OPE-613 defect 1 — the property survives normalization", () => {
  it("b.parentNode and s.id are NOT the same class", () => {
    // The acceptance criterion, verbatim: they must never be the same row.
    expect(normalizeErrorClass(PARENT_NODE)).not.toBe(normalizeErrorClass(S_ID));
  });

  it("keeps the property name in the class", () => {
    expect(normalizeErrorClass(PARENT_NODE)).toContain("parentnode");
    expect(normalizeErrorClass(S_ID)).toContain(".id");
  });

  it("no longer emits the empty `(evaluating )` class that caused the collapse", () => {
    // The exact string the two mis-scoped noise rows were keyed on.
    for (const m of [PARENT_NODE, O_ID, S_ID]) {
      expect(normalizeErrorClass(m)).not.toBe("typeerror: null is not an object (evaluating )");
    }
  });
});

describe("OPE-613 defect 2 — the key survives a minifier rename", () => {
  it("o.id and s.id normalize IDENTICALLY — the rebuild must not move the fault", () => {
    // The whole point. These are the same fault under two bundler outputs, and
    // observed in prod three weeks apart across a deploy.
    expect(normalizeErrorClass(O_ID)).toBe(normalizeErrorClass(S_ID));
  });

  it("the minified object is replaced by a wildcard, not preserved", () => {
    expect(normalizeErrorClass(S_ID)).toContain("*.id");
    expect(normalizeErrorClass(S_ID)).not.toContain("s.id");
  });

  it("a MEANINGFUL object name is kept — cart.id and s.id are different faults", () => {
    // The wildcard applies to bundler locals (1–2 chars), not to real
    // identifiers. Collapsing `cart.id` into `*.id` would recreate defect 1 one
    // level up.
    const cart = normalizeErrorClass("TypeError: null is not an object (evaluating 'cart.id')");
    expect(cart).toContain("cart.id");
    expect(cart).not.toBe(normalizeErrorClass(S_ID));
  });
});

describe("OPE-613 — the denylist after re-keying", () => {
  it("still suppresses b.parentNode, the shape that WAS adjudicated", () => {
    const v = classifyNoise({ message: PARENT_NODE, route: "/events/cummington-fair/2026" });
    expect(v.noise).toBe(true);
  });

  it("suppresses parentNode under a DIFFERENT minified letter too", () => {
    // The rebuild-stability acceptance: demonstrated with a fixture rather than
    // by waiting for a deploy.
    const renamed = "TypeError: null is not an object (evaluating 'q.parentNode')";
    expect(classifyNoise({ message: renamed, route: "/events/x" }).noise).toBe(true);
  });

  it("NO LONGER suppresses the .id family — it has never been adjudicated", () => {
    // Acceptance: "the existing rulings … no longer suppress .id". 34 live
    // occurrences across 20 pathnames, still firing.
    expect(classifyNoise({ message: O_ID, route: "/events/cummington-fair/2026" }).noise).toBe(
      false
    );
    expect(classifyNoise({ message: S_ID, route: "/blog/big-e-parking" }).noise).toBe(false);
  });

  it("carries no denylist entry keyed on a minified local (scope 4)", () => {
    // The audit, as an assertion rather than a comment that can go stale: no
    // entry may contain a quoted 1–2 char object followed by a property.
    for (const entry of THIRD_PARTY_NOISE_DENYLIST) {
      expect(entry).not.toMatch(/(['"`])[a-z_$]{1,2}\.[\w$]+\1/);
    }
  });

  it("the OPE-173 auth-route exemption survives this change", () => {
    // /register#script error. was NOT noise — it was the CORS-masked form of
    // the registration-blocking Turnstile throw. A change to the denylist that
    // quietly re-suppressed conversion routes would be far worse than the bug
    // being fixed.
    expect(classifyNoise({ message: PARENT_NODE, route: "/register" }).noise).toBe(false);
    expect(classifyNoise({ message: "Script error.", route: "/register" }).noise).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  lifecycleRoute,
  describeLifecycleRefusal,
  validateLifecycleTransition,
  LIFECYCLE_TRANSITIONS,
  EVENT_LIFECYCLE,
} from "./index";

/**
 * OPE-675 — the answer to "why can't I go TENTATIVE → OCCURRED" is that the
 * omission is deliberate, so what shipped is a better refusal rather than a
 * new edge. These pin both halves: the edge stays out, and the refusal now
 * tells the caller how to get where they asked to go and what it costs.
 */

describe("the TENTATIVE exclusion is deliberate and stays", () => {
  it("refuses TENTATIVE → OCCURRED and TENTATIVE → NO_SHOW", () => {
    // A tentative event is one nobody confirmed was happening. OCCURRED
    // asserts it took place and NO_SHOW asserts it did not — both are claims
    // nobody made. The K27 sweep measured this population (126 past+TENTATIVE
    // rows) and deliberately declined to widen into it.
    expect(validateLifecycleTransition("TENTATIVE", "OCCURRED").ok).toBe(false);
    expect(validateLifecycleTransition("TENTATIVE", "NO_SHOW").ok).toBe(false);
  });

  it("allows OCCURRED only from the states where the event was confirmed", () => {
    // The real rule, as opposed to the one the docblock used to state. If a
    // future edit widens this, it should fail here and be argued for.
    const canOccur = Object.entries(LIFECYCLE_TRANSITIONS)
      .filter(([, tos]) => tos.includes(EVENT_LIFECYCLE.OCCURRED))
      .map(([from]) => from)
      .sort();
    expect(canOccur).toEqual(["MOVED_ONLINE", "NO_SHOW", "RESCHEDULED", "SCHEDULED"]);
  });
});

describe("lifecycleRoute", () => {
  it("finds the two-hop route the ticket had to reconstruct by hand", () => {
    expect(lifecycleRoute("TENTATIVE", "OCCURRED")).toEqual(["TENTATIVE", "SCHEDULED", "OCCURRED"]);
  });

  it("returns the SHORTEST route, not merely a route", () => {
    // Breadth-first matters: a depth-first walk of this table can wander
    // through POSTPONED or RESCHEDULED and hand back a longer detour, and
    // every extra hop is another false assertion on the record.
    const route = lifecycleRoute("CANCELLED", "OCCURRED")!;
    expect(route).toEqual(["CANCELLED", "SCHEDULED", "OCCURRED"]);
  });

  it("terminates on the table's cycles instead of looping", () => {
    // OCCURRED ↔ NO_SHOW is a closed two-node cycle: NO_SHOW's only target is
    // OCCURRED, which the search has already seen. Without the visited set
    // this call never returns, so the assertion is that it returns AT ALL —
    // and that it correctly reports no route rather than inventing one.
    expect(lifecycleRoute("OCCURRED", "TENTATIVE")).toBeNull();
  });

  it("routes THROUGH a cycle node without getting stuck in it", () => {
    // CANCELLED ↔ SCHEDULED is the other cycle, and unlike the terminal pair
    // it has an exit. The search has to enter SCHEDULED, decline to go back,
    // and carry on.
    expect(lifecycleRoute("CANCELLED", "TENTATIVE")).toEqual([
      "CANCELLED",
      "SCHEDULED",
      "TENTATIVE",
    ]);
  });

  it("returns null for a target that is genuinely unreachable", () => {
    expect(lifecycleRoute("SCHEDULED", "SCHEDULED")).toBeNull();
  });

  it("returns a single-hop route when the edge exists directly", () => {
    expect(lifecycleRoute("SCHEDULED", "OCCURRED")).toEqual(["SCHEDULED", "OCCURRED"]);
  });
});

describe("describeLifecycleRefusal", () => {
  it("names the intermediate state and what asserting it costs", () => {
    // The hint must not read as a recommendation. Passing through SCHEDULED
    // writes "this event is going to happen" onto an elapsed event, and that
    // lands in admin_actions permanently.
    const d = describeLifecycleRefusal("TENTATIVE", "OCCURRED");
    expect(d.route).toEqual(["TENTATIVE", "SCHEDULED", "OCCURRED"]);
    expect(d.hint).toContain("SCHEDULED");
    expect(d.hint).toMatch(/admin_actions/);
    expect(d.hint).toMatch(/Only take the route if the intermediate state is TRUE/);
  });

  it("says so plainly when nothing reaches the target", () => {
    const d = describeLifecycleRefusal("SCHEDULED", "SCHEDULED");
    expect(d.route).toBeNull();
    expect(d.hint).toContain("not reachable");
  });

  it("still reports what IS legal from here", () => {
    const d = describeLifecycleRefusal("TENTATIVE", "OCCURRED");
    expect(d.allowed).toContain("SCHEDULED");
    expect(d.allowed).not.toContain("OCCURRED");
  });
});

describe("validateLifecycleTransition carries the route into the refusal", () => {
  it("attaches route and hint, so both write surfaces can surface them", () => {
    const res = validateLifecycleTransition("TENTATIVE", "OCCURRED");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.route).toEqual(["TENTATIVE", "SCHEDULED", "OCCURRED"]);
    expect(res.hint).toBeTruthy();
    // The pre-existing fields are untouched — the old shape still holds.
    expect(res.reason).toBe("transition TENTATIVE → OCCURRED is not permitted");
    expect(res.allowed).toContain("SCHEDULED");
  });

  it("adds nothing to a permitted transition", () => {
    expect(validateLifecycleTransition("SCHEDULED", "OCCURRED")).toEqual({ ok: true });
  });
});

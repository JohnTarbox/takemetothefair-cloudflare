/**
 * OPE-487 — correcting a terminal lifecycle value that was never transitioned.
 *
 * Found on `granite-state-fair`: `lifecycle_status = OCCURRED` on a fair three
 * weeks in the FUTURE, with `lifecycle_status_changed_at` and `lifecycle_reason`
 * both NULL — i.e. nothing ever transitioned the row; the value arrived with the
 * 2026-01-27 scrape. The state machine correctly refused to fix it, because
 * OCCURRED is terminal.
 *
 * The widening is deliberately a CONJUNCTION, and these tests exist mostly to
 * pin the half that says NO. Measured in production 2026-08-25:
 *
 *     641  live rows in a terminal state
 *     194  with a NULL changed_at
 *     191  of those are genuinely PAST events — correctly backfilled
 *       3  are future-dated — the actual defect
 *
 * So "never transitioned" ALONE would open 194 rows to reach 3, and 191 of the
 * ones it opened are real past fairs. Resurrecting a past event is a thing this
 * codebase has already done once (a tombstone brought back, 2026-08-17), and the
 * terminal states are the guard against it. The future-date condition is what
 * separates "we have no record of the transition" from "the transition cannot
 * have happened".
 */
import { describe, it, expect } from "vitest";
import { validateLifecycleTransition } from "../event-lifecycle";

const NOW = new Date("2026-08-25T12:00:00Z");
const FUTURE = new Date("2026-09-17T12:00:00Z"); // granite-state-fair
const PAST = new Date("2026-07-04T12:00:00Z");

describe("the escape opens — never transitioned AND not yet happened", () => {
  it("corrects the granite-state-fair shape: OCCURRED → SCHEDULED", () => {
    const r = validateLifecycleTransition("OCCURRED", "SCHEDULED", {
      lifecycleStatusChangedAt: null,
      startDate: FUTURE,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.terminalCorrection).toBe(true);
  });

  it("flags the result as a correction, so a caller can audit it differently", () => {
    // An ordinary legal transition must NOT carry the flag — otherwise the audit
    // trail cannot tell a routine change from a guard-bypassing repair.
    const ordinary = validateLifecycleTransition("SCHEDULED", "CANCELLED");
    expect(ordinary.ok).toBe(true);
    expect(ordinary.ok && ordinary.terminalCorrection).toBeUndefined();
  });

  it("applies to NO_SHOW too — both terminal states, same reasoning", () => {
    expect(
      validateLifecycleTransition("NO_SHOW", "SCHEDULED", {
        lifecycleStatusChangedAt: null,
        startDate: FUTURE,
        now: NOW,
      }).ok
    ).toBe(true);
  });
});

describe("the escape stays SHUT — this is the half that matters", () => {
  it("REFUSES when the event is in the past, even with a NULL changed_at", () => {
    // The 191-row case. A backfilled OCCURRED on a fair that really happened is
    // correct, and must stay terminal.
    const r = validateLifecycleTransition("OCCURRED", "SCHEDULED", {
      lifecycleStatusChangedAt: null,
      startDate: PAST,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("not permitted");
  });

  it("REFUSES when the row WAS explicitly transitioned, even if future-dated", () => {
    // Someone or something decided this. Deliberate is not spurious.
    expect(
      validateLifecycleTransition("OCCURRED", "SCHEDULED", {
        lifecycleStatusChangedAt: new Date("2026-08-01T00:00:00Z"),
        startDate: FUTURE,
        now: NOW,
      }).ok
    ).toBe(false);
  });

  it("REFUSES when no context is supplied — the strict table is the default", () => {
    // Every pre-existing caller passes nothing and must be unaffected.
    expect(validateLifecycleTransition("OCCURRED", "SCHEDULED").ok).toBe(false);
  });

  it("REFUSES when start_date is missing — unknown is not future", () => {
    expect(
      validateLifecycleTransition("OCCURRED", "SCHEDULED", {
        lifecycleStatusChangedAt: null,
        startDate: null,
        now: NOW,
      }).ok
    ).toBe(false);
  });

  it("REFUSES an Invalid Date rather than treating NaN as a comparison", () => {
    expect(
      validateLifecycleTransition("OCCURRED", "SCHEDULED", {
        lifecycleStatusChangedAt: null,
        startDate: new Date("not a date"),
        now: NOW,
      }).ok
    ).toBe(false);
  });

  it("NEVER lets the escape create a terminal value", () => {
    // One-directional by construction. If this ever passed, the escape would be
    // a route to marking something occurred without going through the table —
    // which is the opposite of what it is for. OCCURRED→NO_SHOW is legal anyway
    // via the table, so the meaningful assertion is that the CONTEXT is not what
    // permits it: it is permitted with no context at all.
    expect(validateLifecycleTransition("OCCURRED", "NO_SHOW").ok).toBe(true);
    const r = validateLifecycleTransition("OCCURRED", "NO_SHOW", {
      lifecycleStatusChangedAt: null,
      startDate: FUTURE,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.terminalCorrection).toBeUndefined();
  });
});

describe("nothing else moved", () => {
  it("a no-op transition is still rejected", () => {
    expect(
      validateLifecycleTransition("OCCURRED", "OCCURRED", {
        lifecycleStatusChangedAt: null,
        startDate: FUTURE,
        now: NOW,
      }).ok
    ).toBe(false);
  });

  it("the pre-existing table is unchanged for non-terminal sources", () => {
    expect(validateLifecycleTransition("CANCELLED", "SCHEDULED").ok).toBe(true);
    expect(validateLifecycleTransition("TENTATIVE", "OCCURRED").ok).toBe(false);
    expect(validateLifecycleTransition("SCHEDULED", "OCCURRED").ok).toBe(true);
  });

  it("context does not loosen a non-terminal source", () => {
    // TENTATIVE → OCCURRED is illegal and must stay illegal regardless.
    expect(
      validateLifecycleTransition("TENTATIVE", "OCCURRED", {
        lifecycleStatusChangedAt: null,
        startDate: FUTURE,
        now: NOW,
      }).ok
    ).toBe(false);
  });
});

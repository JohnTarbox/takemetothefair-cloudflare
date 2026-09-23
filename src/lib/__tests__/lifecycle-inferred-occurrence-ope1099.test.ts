/**
 * OPE-1099 — "cancelled after we published it."
 *
 * `firefly-yoga-wellness-festival-2026` was cancelled by its organizer and then
 * marked OCCURRED by the end-date sweep, which cannot know. The table refused
 * the correction: OCCURRED is terminal, and OPE-487's escape covers only
 * FUTURE-dated rows.
 *
 * The widening is keyed on who WROTE the terminal value, not on the date. These
 * tests pin the half that says NO as hard as the half that says yes: an
 * OCCURRED a person wrote is an observation and stays terminal, and the escape
 * reaches CANCELLED only — never back to a live state.
 */
import { describe, it, expect } from "vitest";
import { AUTO_OCCURRED_REASON } from "@takemetothefair/constants";
import { validateLifecycleTransition } from "../event-lifecycle";

const PAST = new Date("2026-09-19T12:00:00Z"); // the festival's date
const CHANGED = new Date("2026-09-20T06:00:00Z"); // the sweep's stamp

describe("opens — OCCURRED that the calendar inferred, corrected to CANCELLED", () => {
  it("the Firefly shape: auto-OCCURRED → CANCELLED on a past event", () => {
    const r = validateLifecycleTransition("OCCURRED", "CANCELLED", {
      lifecycleStatusChangedAt: CHANGED,
      lifecycleReason: AUTO_OCCURRED_REASON,
      startDate: PAST,
    });
    expect(r).toEqual({ ok: true, terminalCorrection: true });
  });

  it("the sweep writes exactly the string the escape keys on", () => {
    // If someone rewords the sweep's reason, this correction silently stops
    // opening for every new row. Pin the literal.
    expect(AUTO_OCCURRED_REASON).toBe("auto: end date passed");
  });
});

describe("stays shut", () => {
  it("an OCCURRED a person wrote is an observation, not an inference", () => {
    for (const reason of [
      "2026 edition (July 11-12, Blue Angels headliner) has concluded; added retroactively.",
      "Stale year cleanup — past end_date.",
      null,
    ]) {
      const r = validateLifecycleTransition("OCCURRED", "CANCELLED", {
        lifecycleStatusChangedAt: CHANGED,
        lifecycleReason: reason,
        startDate: PAST,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("a PREFIX is not the reason: exact match only", () => {
    const r = validateLifecycleTransition("OCCURRED", "CANCELLED", {
      lifecycleStatusChangedAt: CHANGED,
      lifecycleReason: `${AUTO_OCCURRED_REASON} — then confirmed by the organizer`,
      startDate: PAST,
    });
    expect(r.ok).toBe(false);
  });

  it("reaches CANCELLED only — an inferred OCCURRED cannot be resurrected to a live state", () => {
    for (const to of ["SCHEDULED", "TENTATIVE", "RESCHEDULED", "POSTPONED"] as const) {
      const r = validateLifecycleTransition("OCCURRED", to, {
        lifecycleStatusChangedAt: CHANGED,
        lifecycleReason: AUTO_OCCURRED_REASON,
        startDate: PAST,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("a caller that passes no context gets the strict table (the safe default)", () => {
    expect(validateLifecycleTransition("OCCURRED", "CANCELLED").ok).toBe(false);
  });

  it("NO_SHOW is not opened — only the sweep's OCCURRED is an inference", () => {
    const r = validateLifecycleTransition("NO_SHOW", "CANCELLED", {
      lifecycleStatusChangedAt: CHANGED,
      lifecycleReason: AUTO_OCCURRED_REASON,
      startDate: PAST,
    });
    expect(r.ok).toBe(false);
  });
});

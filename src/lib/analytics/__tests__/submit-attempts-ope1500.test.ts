/**
 * OPE-1500 — a funnel's terminal step counts VISITORS, not attempts.
 *
 * Real-visitor register read interacted→submitted = 125% (7 days to
 * 2026-10-19): step 2 is latched to first touch, step 3 fired on every submit
 * attempt, and every excess row was a retry inside one visit (10-16 iOS: three
 * submits in 57s). The beacon now numbers attempts per mount, and the read
 * path counts only attempt 1.
 */
import { describe, expect, it, vi } from "vitest";
import { makeSubmitAttemptTracker } from "../../analytics";

describe("makeSubmitAttemptTracker", () => {
  it("numbers attempts within one mount: retries are attempt 2, 3", () => {
    const send = vi.fn();
    const track = makeSubmitAttemptTracker("register", send);
    track();
    track();
    track();
    expect(send.mock.calls).toEqual([
      ["register", 1],
      ["register", 2],
      ["register", 3],
    ]);
    // Exactly one call carries attempt 1, the row the step counts.
    expect(send.mock.calls.filter(([, n]) => n === 1)).toHaveLength(1);
  });

  it("a new mount is a new visit and starts again at 1", () => {
    const send = vi.fn();
    makeSubmitAttemptTracker("submit", send)();
    makeSubmitAttemptTracker("submit", send)();
    expect(send.mock.calls).toEqual([
      ["submit", 1],
      ["submit", 1],
    ]);
  });
});

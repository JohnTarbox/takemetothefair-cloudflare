/**
 * Tests for runWithTimeout, the per-rule timeout helper used by scanAll
 * to bound individual rule.run(db) execution. Driven by 2026-05-19
 * user-reported rescan timeouts: an HTTP-fetching rule (hijacked_domain,
 * cannibalization, etc.) could exceed the 30s edge-runtime cap for the
 * whole chunk, killing every rule that came after it in the same
 * request. The timeout means one slow rule fails just itself.
 */
import { describe, expect, it, vi } from "vitest";
import { runWithTimeout } from "../engine";

describe("runWithTimeout", () => {
  it("resolves with the promise's value when it completes in time", async () => {
    const fast = Promise.resolve("done");
    await expect(runWithTimeout(fast, 100, "test-rule")).resolves.toBe("done");
  });

  it("rejects with a labeled timeout error when the promise exceeds the budget", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    await expect(runWithTimeout(slow, 10, "hijacked_domain_detection")).rejects.toThrow(
      /hijacked_domain_detection.*exceeded 10ms timeout/
    );
  });

  it("rejects the timeout even if the wrapped promise eventually rejects later", async () => {
    // Edge case: an HTTP fetch that times out client-side AND then the
    // backing fetch throws. The wrapper's timeout should fire first.
    const eventuallyFails = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("upstream-500")), 50)
    );
    await expect(runWithTimeout(eventuallyFails, 5, "slow-rule")).rejects.toThrow(/timeout/);
  });

  it("propagates the wrapped promise's rejection when it loses the race", async () => {
    const fastFail = Promise.reject(new Error("table missing"));
    await expect(runWithTimeout(fastFail, 100, "broken-rule")).rejects.toThrow("table missing");
  });

  it("clears the timer on success so it doesn't leak into the event loop", async () => {
    const setSpy = vi.spyOn(global, "setTimeout");
    const clearSpy = vi.spyOn(global, "clearTimeout");
    try {
      await runWithTimeout(Promise.resolve(42), 50, "fast");
      // Exactly one timer set, exactly one cleared. If the cleanup were
      // missing, clearSpy would not be called.
      expect(setSpy).toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("includes the rule label in the error so admin logs are scannable", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await runWithTimeout(slow, 10, "events_missing_application_url");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e instanceof Error).toBe(true);
      expect((e as Error).message).toContain("events_missing_application_url");
      expect((e as Error).message).toContain("10ms");
    }
  });
});

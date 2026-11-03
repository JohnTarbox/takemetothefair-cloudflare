/**
 * OPE-1553 — the crypto-wallet `window.ethereum` provider probe is third-party
 * noise, matched on the browser's quoted TypeError form ONLY.
 *
 * Every positive case sits beside the case it must NOT touch: the server row
 * that echoes the signature in its SQL params (the reason this is not a bare
 * substring), the auth routes (OPE-173), the three OPE-1174 shapes (no
 * regression) and the low-information classes (OPE-613).
 */
import { describe, it, expect } from "vitest";
import { classifyNoise, isWalletProviderProbe, normalizeErrorClass } from "../signature";

// Verbatim from prod error_logs (65 rows, 2026-10-02 → 2026-11-01).
const PROBE =
  "TypeError: undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')";
const PROBE_STACK =
  "global code@https://meetmeatthefair.com/blog/best-payment-apps-for-craft-fair-vendors-in-2026:1:16";

// Verbatim shape of the ONE server row that matched `LIKE '%window.ethereum%'`
// in the same window: a ledger write failure quoting the signature in params.
const SERVER_ECHO =
  'stale-red signal persistence failed — resolution state did NOT advance (digest delivery unaffected): Failed query: insert into "stale_red_signals" ("ref_key") values (?)\n' +
  "params: /events/wachusett-mountain-applefest/2026#typeerror: undefined is not an object (evaluating window.ethereum.selectedaddress),P1\n" +
  "cause: D1_ERROR: Network connection lost.";

describe("OPE-1553 wallet provider probe", () => {
  it.each(["/events/rhode-island", "/events/newton-harvest-fair/2026", "/blog/x", "/"])(
    "ACCEPTANCE: on a new route %s the probe is third-party noise (mints no proposed row)",
    (route) => {
      const v = classifyNoise({ message: PROBE, route, stackTrace: PROBE_STACK });
      expect(v).toEqual({
        noise: true,
        reason: "third-party",
        matched: "wallet-probe:window.ethereum",
      });
    }
  );

  it("matches any window.ethereum property and without a stack", () => {
    expect(
      classifyNoise({
        message: "TypeError: undefined is not an object (evaluating 'window.ethereum.isMetaMask')",
        route: "/events/maine",
        stackTrace: null,
      }).noise
    ).toBe(true);
  });

  it("NEGATIVE: the server row that ECHOES the signature is NOT suppressed", () => {
    // The precise reason this is not a bare `window.ethereum` substring.
    expect(SERVER_ECHO.toLowerCase()).toContain("window.ethereum");
    expect(isWalletProviderProbe(SERVER_ECHO)).toBe(false);
    expect(classifyNoise({ message: SERVER_ECHO, route: null }).noise).toBe(false);
  });

  it("NEGATIVE: an already-NORMALIZED class (quotes stripped) is not matched", () => {
    expect(isWalletProviderProbe(normalizeErrorClass(PROBE))).toBe(false);
  });

  it.each(["/login", "/register"])("ACCEPTANCE: on %s it stays a candidate (OPE-173)", (route) => {
    const v = classifyNoise({ message: PROBE, route, stackTrace: PROBE_STACK });
    expect(v.noise).toBe(false);
    expect(v.matched).toBe("wallet-probe:window.ethereum");
  });

  it("NO REGRESSION: the three OPE-1174 shapes are still noise", () => {
    for (const message of [
      "Error: Invalid call to runtime.sendMessage(). Tab not found.",
      "Error: WKWebView API client did not respond to this postMessage",
      "Error: Invalid origin",
    ]) {
      expect(classifyNoise({ message, route: "/events/maine", stackTrace: null }).noise).toBe(true);
    }
  });

  it("LANDMARK: low-information classes still mint (OPE-613 untouched)", () => {
    for (const message of [
      "undefined",
      "TypeError: undefined is not an object (evaluating 'cart.items')",
    ]) {
      expect(
        classifyNoise({ message, route: "/events/maine", stackTrace: PROBE_STACK }).noise
      ).toBe(false);
    }
    // and `script error.` off auth routes remains the OPE-251 third-party entry, not ours
    expect(classifyNoise({ message: "Script error.", route: "/events/maine" }).matched).toBe(
      "script error."
    );
  });
});

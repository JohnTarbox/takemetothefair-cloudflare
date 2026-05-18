/**
 * Pure-function tests for the inbound email intent router.
 * No I/O, no mocks.
 */
import { describe, expect, it } from "vitest";
import { resolveIntent, shouldForwardToAdmin } from "../src/email-intents.js";

describe("resolveIntent — recognized addresses", () => {
  it("submit@ → submit", () => {
    expect(resolveIntent("submit@meetmeatthefair.com")).toBe("submit");
  });
  it("corrections@ → correction", () => {
    expect(resolveIntent("corrections@meetmeatthefair.com")).toBe("correction");
  });
  it("support@ → support", () => {
    expect(resolveIntent("support@meetmeatthefair.com")).toBe("support");
  });
  it("hello@ → support (same intent as support@)", () => {
    expect(resolveIntent("hello@meetmeatthefair.com")).toBe("support");
  });
  it("press@ → press", () => {
    expect(resolveIntent("press@meetmeatthefair.com")).toBe("press");
  });
  it("unsubscribe@ → unsubscribe", () => {
    expect(resolveIntent("unsubscribe@meetmeatthefair.com")).toBe("unsubscribe");
  });
});

describe("resolveIntent — normalization", () => {
  it("uppercase recipient address", () => {
    expect(resolveIntent("SUBMIT@meetmeatthefair.com")).toBe("submit");
  });
  it("mixed-case", () => {
    expect(resolveIntent("Corrections@MeetMeAtTheFair.com")).toBe("correction");
  });
  it("surrounding whitespace", () => {
    expect(resolveIntent("  submit@meetmeatthefair.com  ")).toBe("submit");
  });
});

describe("resolveIntent — unknown / catch-all", () => {
  it("never-configured @meetmeatthefair address falls through", () => {
    expect(resolveIntent("billing@meetmeatthefair.com")).toBe("unknown");
  });
  it("wrong domain falls through", () => {
    expect(resolveIntent("submit@example.com")).toBe("unknown");
  });
  it("empty string falls through", () => {
    expect(resolveIntent("")).toBe("unknown");
  });
  it("malformed address falls through", () => {
    expect(resolveIntent("not-an-email")).toBe("unknown");
  });
});

describe("shouldForwardToAdmin", () => {
  it("submit does NOT forward (events land in D1 for admin review)", () => {
    expect(shouldForwardToAdmin("submit")).toBe(false);
  });
  it("correction forwards", () => {
    expect(shouldForwardToAdmin("correction")).toBe(true);
  });
  it("support forwards", () => {
    expect(shouldForwardToAdmin("support")).toBe(true);
  });
  it("press forwards", () => {
    expect(shouldForwardToAdmin("press")).toBe(true);
  });
  it("unsubscribe forwards (so admin sees opt-outs)", () => {
    expect(shouldForwardToAdmin("unsubscribe")).toBe(true);
  });
  it("unknown forwards (catch-all goes to admin)", () => {
    expect(shouldForwardToAdmin("unknown")).toBe(true);
  });
});

/**
 * Pure-function tests for the inbound email intent router.
 * No I/O, no mocks.
 */
import { describe, expect, it } from "vitest";
import { resolveIntent, shouldForwardToAdmin, toWorkflowIntent } from "../src/email-intents.js";

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

describe("toWorkflowIntent — classifier → workflow dispatch mapping", () => {
  it("legacy values pass through unchanged", () => {
    expect(toWorkflowIntent("submit")).toBe("submit");
    expect(toWorkflowIntent("correction")).toBe("correction");
    expect(toWorkflowIntent("support")).toBe("support");
    expect(toWorkflowIntent("press")).toBe("press");
    expect(toWorkflowIntent("unsubscribe")).toBe("unsubscribe");
    expect(toWorkflowIntent("unknown")).toBe("unknown");
  });
  it("new_event collapses to submit (same pipeline)", () => {
    expect(toWorkflowIntent("new_event")).toBe("submit");
  });
  it("source_suggestion routes through correction handler", () => {
    expect(toWorkflowIntent("source_suggestion")).toBe("correction");
  });
  it("claim_request routes through correction handler", () => {
    expect(toWorkflowIntent("claim_request")).toBe("correction");
  });
  it("vendor_inquiry routes through support handler", () => {
    expect(toWorkflowIntent("vendor_inquiry")).toBe("support");
  });
  it("spam/unclear/multi route to unknown (admin triage)", () => {
    expect(toWorkflowIntent("spam")).toBe("unknown");
    expect(toWorkflowIntent("unclear")).toBe("unknown");
    expect(toWorkflowIntent("multi")).toBe("unknown");
  });
});

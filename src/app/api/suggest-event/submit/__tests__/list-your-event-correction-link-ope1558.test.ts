/**
 * OPE-1558 decision 1a — the /list-your-event receipt carries a private
 * correction link; no other submission's receipt does.
 *
 * Source-level, like the rest of this folder (the route is a Next handler with
 * D1/Turnstile/rate-limit dependencies; what is under test is wiring). Anchored
 * on the argument syntax, not bare symbols, so an import line cannot satisfy it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/suggest-event/submit/route.ts"),
  "utf8"
);
const ARG = "mintCorrectionUrl: ";

describe("OPE-1558 — correction link on the no-login form's receipt", () => {
  it("landmark: the ack is sent once, and the mint is an argument OF that call", () => {
    const callAt = ROUTE.indexOf("sendSubmissionReceivedAck(db,");
    const argAt = ROUTE.indexOf(ARG);
    expect(callAt).toBeGreaterThan(-1);
    expect(argAt).toBeGreaterThan(callAt);
    // Nothing closes the call between the two: the arg is inside it.
    expect(ROUTE.slice(callAt, argAt)).not.toMatch(/\n {6}\}\);/);
    expect(ROUTE.split(ARG).length - 1).toBe(1);
  });

  it("is gated on the stored list-your-event tag, so /suggest-event receipts are unchanged", () => {
    const argAt = ROUTE.indexOf(ARG);
    expect(ROUTE.slice(argAt, argAt + 80)).toMatch(
      /^mintCorrectionUrl: tagList\.includes\("list-your-event"\)\s*\?/
    );
  });

  it("mints a web-form token (inboundEmailId: null) and links the existing correction form", () => {
    const argAt = ROUTE.indexOf(ARG);
    const body = ROUTE.slice(argAt, argAt + 500);
    expect(body).toMatch(
      /issueCorrectionToken\(db, \{\s*eventId: newEventId,\s*inboundEmailId: null,/
    );
    expect(body).toContain("`${SITE_URL}/submit-event/${token}`");
    expect(body).toMatch(/: undefined,/);
  });
});

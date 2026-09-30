/**
 * OPE-1153 — one acknowledgment per submit@ email.
 *
 * The inbound-email workflow answers the sender itself (`reply:ok-*`), then
 * creates the event through THIS route with X-Internal-Key. The route used to
 * send OPE-412's web-form receipt as well, so every email submitter got two
 * acks 3s apart (5 recipients, 18 pairs in 30 days, measured 2026-09-25).
 *
 * Source-level, like the other tests in this folder: the route is a Next
 * handler with D1, Turnstile and rate-limit dependencies, and what is under
 * test is wiring. Anchored on CALL syntax (`sendSubmissionReceivedAck(`), not
 * the bare symbol, which would also match the import line.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/suggest-event/submit/route.ts"),
  "utf8"
);
const CALL = "sendSubmissionReceivedAck(db,";

describe("OPE-1153 — the web-form ack is not sent on the email lane", () => {
  it("landmark: the route still sends the ack exactly once (web form, OPE-412)", () => {
    expect(ROUTE.split(CALL).length - 1).toBe(1);
  });

  it("landmark: isInternal is the X-Internal-Key check", () => {
    expect(ROUTE).toMatch(/const isInternal = await internalKeyMatches\(request\)/);
  });

  it("the send sits in the non-internal branch of an isInternal guard", () => {
    const callAt = ROUTE.indexOf(CALL);
    // Anchored on the whole assignment: a bare "isInternal" would also match
    // the tail of an inverted `!isInternal` guard and pass it.
    const guardAt = ROUTE.lastIndexOf("const ackOutcome = ", callAt);
    expect(guardAt).toBeGreaterThan(-1);
    const between = ROUTE.slice(guardAt, callAt);
    // `isInternal ? <skip> : await send(...)` — the skip is the TRUE branch.
    expect(between).toMatch(
      /^const ackOutcome = isInternal\s*\?\s*\("skipped:internal-caller" as const\)\s*:\s*await $/
    );
  });

  it("the deliberate skip is not logged as a failed send", () => {
    expect(ROUTE).toContain('ackOutcome !== "skipped:internal-caller"');
  });
});

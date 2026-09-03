/**
 * OPE-766 — the acknowledgement now goes out on arrival, not seven days later.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * The handler already chose `correction-ack` / `press-ack`. The admin-decision
 * pause sat BETWEEN that choice and the send, and on timeout overwrote the
 * reply with the SAME kind — so the ack shipped a week after the message.
 *
 * Measured over the whole of `email_send_ledger`: ten automated acks on the
 * correction / press / claim_request lanes, **every one at a gap of 7.0001
 * days**. Not one prompt acknowledgement has ever been sent. The only faster
 * replies are `reply:manual` — a person, by hand.
 *
 * John approved the change directly on 2026-09-02: prompt ack on all three
 * lanes, keeping the 7-day decision window.
 *
 * ── Why these are SOURCE-level assertions ─────────────────────────────────
 * The fix is an ORDERING. Nothing about the shape of the data changes, so a
 * unit test on any single function passes identically before and after — the
 * defect lives in which step runs first, and only the source can show that.
 * This mirrors `fanout-gate-bare-url-ope537.test.ts`, which pins a gate the
 * same way for the same reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildReply } from "../src/email-reply-builder.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/workflows/inbound-email.ts", import.meta.url)),
  "utf8"
);

/** Character offset of a step declaration, anchored on the step NAME literal. */
function stepAt(name: string): number {
  const i = SRC.indexOf(`"${name}"`);
  expect(
    i,
    `step "${name}" not found in the workflow — this guard is inert, not passing`
  ).toBeGreaterThan(-1);
  return i;
}

describe("OPE-766 — the ack is sent BEFORE the admin-decision pause", () => {
  it("orders send-reply ahead of mark-waiting and the waitForEvent", () => {
    const sendReply = stepAt("send-reply");
    const markWaiting = stepAt("mark-waiting");
    const waitForEvent = SRC.indexOf("waitForEvent<AdminDecision>");

    expect(waitForEvent, "the admin-decision waitForEvent is gone entirely").toBeGreaterThan(-1);

    // The whole fix, in two comparisons. Before OPE-766 both were NEGATIVE.
    expect(
      markWaiting - sendReply,
      "mark-waiting runs BEFORE send-reply — the ack is once again gated behind " +
        "the 7-day pause, which is the defect this ticket fixed"
    ).toBeGreaterThan(0);
    expect(waitForEvent - sendReply).toBeGreaterThan(0);
  });

  it("keeps the 7-day window — the pause was moved, not removed", () => {
    // LANDMARK. "Ack promptly" must not have been achieved by deleting the
    // human-review window; John approved keeping it.
    expect(SRC).toMatch(/timeout:\s*"7 days"/);
  });
});

describe("OPE-766 — the timeout no longer sends a second, identical ack", () => {
  it("computes the decision reply only inside a `decision !== null` branch", () => {
    // `decisionToReplyKind(intent, null)` returns the generic ack, and its own
    // docblock says why: "fall back to the generic ack so the sender doesn't go
    // forever without acknowledgement." That fallback existed ONLY because
    // nothing acknowledged on arrival.
    //
    // Now something does — so firing it on timeout would deliver a second,
    // byte-identical email a week later. That is exactly OPE-720: Emma Welford
    // received two `correction-ack`s for one message.
    const guard = SRC.indexOf("if (decision !== null)");
    const call = SRC.indexOf("decisionToReplyKind(intent, decision)");

    expect(guard, "the `decision !== null` guard is gone — a timeout will re-ack").toBeGreaterThan(
      -1
    );
    expect(call).toBeGreaterThan(-1);
    expect(
      call - guard,
      "decisionToReplyKind is reached outside the decision guard, so a timed-out " +
        "pause will send the generic ack a second time"
    ).toBeGreaterThan(0);
  });

  it("gives the decision reply its own ledger key, so the two sends cannot collide", () => {
    // The ack ledgers as `reply-${messageRowId}`. Reusing that key for the
    // decision reply would make them collide on the idempotency key — and the
    // one carrying an actual answer is the one that would be dropped.
    expect(SRC).toContain("`decision-${messageRowId}`");
    expect(SRC).toContain("`reply-${messageRowId}`");
  });
});

describe("OPE-766 — the copy was always written for a prompt send", () => {
  it("says 'shortly', which is true in minutes and absurd after a week", () => {
    // This is the premise of the whole change, so it is pinned rather than
    // asserted in prose: the templates were written for a message that arrives
    // promptly. Delivering them 7.0001 days later is what made them wrong.
    //
    // If someone rewrites this copy (OPE-367's scope), this test failing is the
    // intended prompt to re-read why the timing changed.
    expect(buildReply("correction-ack", "a@b.com", { subject: "x" }).text).toContain("shortly");
    expect(buildReply("press-ack", "a@b.com", { subject: "x" }).text).toContain("shortly");
  });

  it("LANDMARK: no new customer-facing copy was introduced", () => {
    // OPE-761's STOP-gate covers new ack COPY; John approved the timing, and
    // OPE-367 owns the wording. These two templates are unchanged and have been
    // sending for months — only when they send has changed.
    const correction = buildReply("correction-ack", "a@b.com", { subject: "x" }).text;
    expect(correction).toContain("We've recorded your correction request");
  });
});

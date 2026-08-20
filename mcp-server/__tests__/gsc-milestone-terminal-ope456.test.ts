/**
 * OPE-456 scope 1a — a successfully-ingested GSC milestone is terminal.
 *
 * The auto-ingest already ran and then FELL THROUGH to the classifier and the
 * submission workflow. One email, two consumers, one of them wrong: the 12K
 * milestone stored correctly, and the submission lane replied to Google Search
 * Console that it forgot to include a link to its event.
 *
 * Source-level, because the behaviour is a `return` in the middle of a Workers
 * email handler that needs a full CF `ForwardableEmailMessage`, a main-app
 * fetch and a live D1 to exercise end to end. What is worth pinning is the
 * control flow: the terminal return exists, it is gated on the endpoint
 * ACCEPTING the mail, and it sits after the ingest rather than before it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/email-handler.ts", import.meta.url), "utf8");

/** The OPE-311 auto-ingest block, from its marker to the next numbered step. */
function ingestBlock(): string {
  const start = SRC.indexOf("3b-iv. OPE-311");
  const end = SRC.indexOf("3b-v. OPE-317");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("a stored milestone stops the pipeline", () => {
  it("returns early, so the classifier and workflow never run", () => {
    const block = ingestBlock();
    expect(block).toContain("return;");
  });

  it("records a terminal row rather than returning silently", () => {
    // A bare `return` would leave no trace that the mail arrived at all.
    const block = ingestBlock();
    expect(block).toContain("insertAuditNoopRow");
    expect(block).toContain("gsc-milestone-ingested");
  });

  it("the terminal return is gated on res.ok, not on the pre-filter", () => {
    // Load-bearing: the endpoint answers 400 `not_a_milestone` when the subject
    // matches neither shape, so terminating on `looksLikeGscMilestone` alone
    // would swallow ordinary sc-noreply mail. The gate must be the ANSWER.
    const block = ingestBlock();
    const gate = block.indexOf("if (res.ok) {");
    const ret = block.indexOf("return;", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(gate);
  });

  it("terminates AFTER the ingest call, never before it", () => {
    // Returning before the POST would drop the milestone entirely — trading a
    // wrong reply for a lost signal, which is the opposite of the fix.
    const block = ingestBlock();
    const post = block.indexOf("gsc-milestone-ingest");
    const gate = block.indexOf("if (res.ok) {");
    expect(post).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(post);
  });

  it("does not widen the classifier intent taxonomy", () => {
    // Deliberate: the taxonomy has many consumers. This email has no remaining
    // work once stored, so it terminates like subscribe@ instead.
    expect(SRC).not.toContain('"gsc_milestone"');
  });
});

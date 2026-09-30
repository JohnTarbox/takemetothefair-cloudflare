/**
 * OPE-1134 — the ack matches what the sender asked, and promises nothing
 * nobody delivers.
 *
 * Specimens: carol.pace@davidlerner.com (vendor_inquiry, 2026-07-08) got the
 * bug-report support-ack and then 8 weeks of silence; boblloydmagic@gmail.com
 * (claim_request, 2026-07-22) got "we've recorded your correction request".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ackKindForIntent } from "../src/email-handlers/ack-kind.js";
import { buildReply } from "../src/email-reply-builder.js";
import { NEUTRAL_FALLBACK } from "../src/email-handlers/template-assertions.js";
import { THREAD_REPLY_OVERRIDABLE_KINDS } from "../src/email-handlers/thread-reply-ack.js";

const read = (rel: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");

describe("intent → ack, pair by pair", () => {
  it.each([
    ["vendor_inquiry", "vendor-inquiry-ack"],
    ["claim_request", "claim-request-ack"],
    ["correction", "correction-ack"],
    ["source_suggestion", "correction-ack"],
    ["press", "press-ack"],
    ["support", "support-ack"],
    ["unclear", "support-ack"],
    [null, "support-ack"],
  ])("%s → %s", (intent, kind) => {
    expect(ackKindForIntent(intent)).toBe(kind);
  });
});

describe("the handlers choose from the CLASSIFIER's intent, not the collapsed dispatch intent", () => {
  it("support.ts (where vendor_inquiry lands) uses ackKindForIntent(row.classifiedIntent)", () => {
    expect(read("src/email-handlers/support.ts")).toMatch(
      /replyKind: ackKindForIntent\(row\.classifiedIntent\)/
    );
  });
  it("correction.ts (where claim_request lands) answers a claim with the claim ack", () => {
    expect(read("src/email-handlers/correction.ts")).toMatch(
      /row\.classifiedIntent === "claim_request" \? "claim-request-ack" : "correction-ack"/
    );
  });
  it("the workflow's timeout fallback does the same for claim_request", () => {
    expect(read("src/workflows/inbound-email.ts")).toMatch(
      /if \(intent === "claim_request"\) return "claim-request-ack";/
    );
  });
});

const ACKS = [
  "support-ack",
  "vendor-inquiry-ack",
  "claim-request-ack",
  "correction-ack",
  "press-ack",
] as const;

describe("no ack promises a human follow-up that no handler delivers", () => {
  it.each(ACKS)("%s", (kind) => {
    const text = buildReply(kind, "a@b.test", { subject: "x" }).text;
    expect(text).not.toMatch(
      /shortly|will get back|follow up|will review it|our team will|a team member will/i
    );
  });

  it("the vendor ack points at things that exist, and says it is automatic", () => {
    const text = buildReply("vendor-inquiry-ack", "a@b.test", { subject: "x" }).text;
    expect(text).toContain("https://meetmeatthefair.com/vendors");
    expect(text).toContain("Claim this free listing");
    expect(text).toContain("hasn't been read by a person yet");
  });
});

describe("the new acks inherit the mid-thread guard (their claim is false in a thread)", () => {
  it.each(["vendor-inquiry-ack", "claim-request-ack"] as const)("%s", (kind) => {
    expect(NEUTRAL_FALLBACK[kind]).toBe("thread-reply-ack");
    expect(THREAD_REPLY_OVERRIDABLE_KINDS).toContain(kind);
  });
});

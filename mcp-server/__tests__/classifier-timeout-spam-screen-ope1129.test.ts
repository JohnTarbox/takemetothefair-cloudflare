/**
 * OPE-1129 — a classifier TIMEOUT must not skip the solicitation screen.
 *
 * The specimen: inbound 2f35a893 (2026-09-18), an attendee-list pitch to
 * hello@. Stored row: `classified_rationale='classifier-error:
 * intent-classifier-timeout'`, `routing_source='address_only'`,
 * `status='replied'`. The OPE-278 screen ran only after a SUCCESSFUL model
 * call, so the timeout returned `unclear` from the catch, address routing sent
 * hello@ to support, and the support ack told a list broker the inbox is live.
 *
 * The acceptance is "no auto-ack". A quarantined message gets no workflow and
 * so no reply of any kind, and `shouldQuarantineAsSpam` IS the entrypoint's
 * gate (email-handler.ts calls it) — so asserting on it asserts on the send
 * decision, not on a copy of its condition.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyIntent,
  shouldQuarantineAsSpam,
  type AiBinding,
} from "../src/intent-classifier.js";

/** inbound 2f35a893, verbatim from the stored row (trimmed at the sign-off). */
const SPECIMEN = {
  toAddress: "hello@meetmeatthefair.com",
  fromAddress: "charles.anderson.leadstream@gmail.com",
  senderTrustTier: "unknown" as const,
  isReplyToOurThread: false,
  attachmentCount: 0,
  attachmentTypes: [],
  subject: "47th Annual Fall Connecticut Home Show 2026: Full List of Registered Visitors",
  bodyText:
    "Hi,\n\nI hope you’re doing well.\n\nWe’re pleased to offer access to the *47th Annual Fall " +
    "Connecticut Home\nShow 2026 Pre-Registered Attendee List*, at a special discounted price for\n" +
    "a limited time.\n\n*Event:* 47th Annual Fall Connecticut Home Show 2026\n*Date:* 31 October – " +
    "01 November, 2026\n*Attendees/Visitors:* 7,500\n\n*The list includes:*\n• Contact Name\n" +
    "• Job Title\n• Company Name\n• Verified Business Email Address\n• Mobile Number\n\n" +
    "If you’re interested, please let us know and\n\n*we’ll be happy to share the pricing, list " +
    "details, and additional\ninformation. *",
};

/** A genuine support question — the population a blanket fail-closed would silence. */
const LEGIT = {
  ...SPECIMEN,
  fromAddress: "visitor@example.com",
  subject: "Parking at the Fryeburg Fair?",
  bodyText: "Hi, is there parking on site at the Fryeburg Fair this year, and is it free?",
};

const hang = () => new Promise<never>(() => {});
const timesOut: () => AiBinding = () => ({ run: vi.fn(() => hang()) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function classifyWithTimers(ai: AiBinding, input: typeof SPECIMEN) {
  const p = classifyIntent(ai, input);
  await vi.advanceTimersByTimeAsync(4000 * 3); // both attempts' deadlines + slack
  return p;
}

describe("OPE-1129 — the screen runs whatever the model did", () => {
  it("ACCEPTANCE: the specimen, with the model timing out, is quarantined — no ack", async () => {
    const r = await classifyWithTimers(timesOut(), SPECIMEN);

    expect(shouldQuarantineAsSpam(r)).toBe(true);
    expect(r.intents[0].intent).toBe("spam");
    // The rationale records the model's failure honestly rather than hiding it.
    expect(r.intents[0].rationale).toMatch(/solicitation-screen/);
    expect(r.intents[0].rationale).toMatch(/intent-classifier-timeout/);
    // Both attempts still ran — the screen does not pre-empt the model.
    expect(r.attempts).toBe(2);
  });

  it("any other model error is screened too — not just the timeout", async () => {
    const ai: AiBinding = {
      run: vi.fn(async () => {
        throw new Error("5028: model deprecated");
      }),
    };
    const r = await classifyWithTimers(ai, SPECIMEN);
    expect(shouldQuarantineAsSpam(r)).toBe(true);
  });

  it("a legitimate question that times out is NOT quarantined — it keeps its ack", async () => {
    // The deliberate half: this is why the fix is "screen on error" and not
    // "fail closed on error". ~10% of all inbound times out (OPE-1089).
    const r = await classifyWithTimers(timesOut(), LEGIT);

    expect(shouldQuarantineAsSpam(r)).toBe(false);
    expect(r.fromAi).toBe(false);
    expect(r.intents[0].rationale).toBe("classifier-error: intent-classifier-timeout");
  });

  it("the success path still screens, with the model's verdict in the rationale", async () => {
    const ai: AiBinding = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          intent: "support",
          confidence: 0.8,
          rationale: "asks about an event",
        }),
      })),
    };
    const r = await classifyWithTimers(ai, SPECIMEN);
    expect(shouldQuarantineAsSpam(r)).toBe(true);
    expect(r.intents[0].rationale).toMatch(/classifier said support/);
  });
});

describe("shouldQuarantineAsSpam is the gate, pinned from both sides", () => {
  const base = {
    version: "v",
    startedAt: 0,
    finishedAt: 0,
    attempts: 1,
  };
  const verdict = (intent: string, confidence: number, fromAi: boolean) => ({
    ...base,
    fromAi,
    intents: [
      {
        intent: intent as never,
        subIntent: null,
        confidence,
        rationale: "",
        refUrl: null,
        refEventClue: null,
      },
    ],
  });

  it("requires spam, high confidence AND a verdict", () => {
    expect(shouldQuarantineAsSpam(verdict("spam", 0.95, true))).toBe(true);
    expect(shouldQuarantineAsSpam(verdict("spam", 0.5, true))).toBe(false);
    expect(shouldQuarantineAsSpam(verdict("spam", 0.95, false))).toBe(false);
    expect(shouldQuarantineAsSpam(verdict("support", 0.95, true))).toBe(false);
  });
});

describe("the entrypoint uses THIS gate, not a copy of its condition", () => {
  it("email-handler.ts decides quarantine with shouldQuarantineAsSpam(result)", () => {
    const src = readFileSync(new URL("../src/email-handler.ts", import.meta.url), "utf8");
    // Anchored on the call syntax, not the bare symbol — a bare `indexOf`
    // would match the import line and pass with the call deleted.
    expect(src).toMatch(/if\s*\(\s*shouldQuarantineAsSpam\(result\)\s*\)/);
    // And the old inline condition is gone, so there is one gate, not two.
    expect(src).not.toMatch(
      /top\.intent === "spam" && top\.confidence >= SPAM_QUARANTINE_THRESHOLD/
    );
  });
});

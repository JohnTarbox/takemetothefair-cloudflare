/**
 * OPE-1089 — the classifier retries ONCE, and only on a timeout.
 *
 * Measured before writing any of this: 23 of 233 classified rows (9.9%) failed,
 * every one of them `intent-classifier-timeout`, in every month since launch.
 * In-Worker latency (n=70) was p50 2079ms / p95 3317ms with a max SUCCESS of
 * 3951ms — 49ms under the deadline — and all 6 failures sat at exactly 4000ms.
 *
 * The tail is what chose a retry over a bigger number: 40 further samples ran
 * p50 1351 / p95 3744 with one **10,775ms** outlier, so no tolerable timeout
 * catches the spike, while a fresh second attempt does.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { classifyIntent, type AiBinding } from "../src/intent-classifier.js";

const INPUT = {
  toAddress: "submit@meetmeatthefair.com",
  fromAddress: "organizer@example.com",
  senderTrustTier: "unknown" as const,
  isReplyToOurThread: false,
  attachmentCount: 0,
  attachmentTypes: [],
  subject: "Litchfield Fair 2026",
  bodyText: "Please add our fair, Sept 4-7 2026 at the Litchfield fairgrounds.",
};

const GOOD = JSON.stringify({
  intent: "new_event",
  sub_intent: "free_text",
  confidence: 0.94,
  rationale: "prose description with name + date + venue",
});

/** A call that never settles — the shape a real timeout races against. */
const hang = () => new Promise<never>(() => {});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Run `classifyIntent` while letting the 4000ms timers fire. */
async function runWithTimers(ai: AiBinding) {
  const p = classifyIntent(ai, INPUT);
  // Two attempts' worth of deadline, plus slack.
  await vi.advanceTimersByTimeAsync(4000 * 3);
  return p;
}

describe("OPE-1089 — retry on timeout", () => {
  it("ACCEPTANCE: a first-attempt timeout is recovered by the retry", async () => {
    let n = 0;
    const ai: AiBinding = {
      run: vi.fn(async () => {
        n++;
        if (n === 1) return hang();
        return { response: GOOD };
      }),
    };

    const r = await runWithTimers(ai);

    expect(r.fromAi).toBe(true);
    expect(r.intents[0].intent).toBe("new_event");
    expect(r.attempts).toBe(2);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("a first-attempt success costs exactly one call", async () => {
    const ai: AiBinding = { run: vi.fn(async () => ({ response: GOOD })) };

    const r = await runWithTimers(ai);

    expect(r.fromAi).toBe(true);
    expect(r.attempts).toBe(1);
    // The load-bearing half: no speculative second call on the happy path.
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("two timeouts give up — it retries ONCE, not forever", async () => {
    const ai: AiBinding = { run: vi.fn(() => hang()) };

    const r = await runWithTimers(ai);

    expect(r.fromAi).toBe(false);
    expect(r.intents[0].intent).toBe("unclear");
    expect(r.intents[0].rationale).toBe("classifier-error: intent-classifier-timeout");
    expect(r.attempts).toBe(2);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });
});

describe("OPE-1089 — only on timeout", () => {
  it("a DETERMINISTIC error is not retried — the 2026-06-15 `5028 deprecated` outage", async () => {
    // Retrying this doubled the cost of an outage no retry could fix: every
    // call returned it, for hours, until the model id was changed.
    const ai: AiBinding = {
      run: vi.fn(async () => {
        throw new Error(
          "5028: This model was deprecated on 2026-05-30. Please use an alternative model."
        );
      }),
    };

    const r = await runWithTimers(ai);

    expect(r.fromAi).toBe(false);
    expect(r.intents[0].rationale).toContain("5028");
    expect(r.attempts).toBe(1);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("a non-string `.response` is not retried either — it is the 3B shape, not slowness", async () => {
    // v2's failure mode: the call RETURNS, promptly, with an unusable shape.
    // There is nothing for a second attempt to improve.
    const ai: AiBinding = { run: vi.fn(async () => ({ response: { tool_calls: [] } })) };

    const r = await runWithTimers(ai);

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(r.attempts).toBe(1);
    // It degrades through the JSON path rather than the error path.
    expect(r.intents[0].intent).toBe("unclear");
  });
});

describe("OPE-1089 — attempts is reported on every path", () => {
  it("is present on success, on retry-success and on give-up", async () => {
    const ok: AiBinding = { run: vi.fn(async () => ({ response: GOOD })) };
    const dead: AiBinding = { run: vi.fn(() => hang()) };

    // Pinned because `attempts` is the ONLY signal that the retry is doing
    // anything in production — it is logged into the same `error_logs` rows
    // whose durationMs measured the original 9.9% failure rate. If it stopped
    // being populated, the fix would be unfalsifiable rather than wrong.
    expect((await runWithTimers(ok)).attempts).toBe(1);
    expect((await runWithTimers(dead)).attempts).toBe(2);
  });
});

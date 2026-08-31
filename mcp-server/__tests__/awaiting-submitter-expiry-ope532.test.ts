/**
 * OPE-532 ruling part 2 — the bounded awaiting-submitter expiry.
 *
 * Two properties matter more than the arithmetic, and both are ways this could
 * ship green while doing harm:
 *
 *   1. It must NOT reach kinds where WE owe the reply. `support-ack` is
 *      structurally identical to `no-url` — status='replied', no resulting
 *      event, ageing quietly, 30 live rows at 72 days — and points the other
 *      way. An expiry keyed on shape would close real unanswered customers.
 *   2. An expired row must stay COUNTABLE and distinguishable from one a human
 *      resolved. The reopening comment names this: "an auto-close that silently
 *      drops rows out of every counter recreates the defect with a tidier name."
 */
import { describe, it, expect } from "vitest";
import {
  classifyAwaitingSubmitter,
  isAwaitingSubmitterKind,
  awaitingSubmitterCutoff,
  summariseAwaitingSubmitter,
} from "../src/inbound/awaiting-submitter.js";
import { AWAITING_SUBMITTER_EXPIRY_DAYS } from "@takemetothefair/constants";

const NOW = new Date("2026-08-31T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

const row = (over: Partial<Parameters<typeof classifyAwaitingSubmitter>[0]> = {}) => ({
  replyKind: "no-url",
  status: "replied",
  receivedAt: daysAgo(1),
  resultingEventId: null,
  ...over,
});

describe("the queue is defined by WHO OWES THE REPLY, not by row shape", () => {
  it("owns no-url — we asked the sender for a link", () => {
    expect(isAwaitingSubmitterKind("no-url")).toBe(true);
  });

  it("does NOT own support-ack — the customer asked US", () => {
    // The trap. 30 live rows, oldest 72 days, structurally identical to no-url.
    // Expiring these would auto-close genuine unanswered customer questions.
    expect(isAwaitingSubmitterKind("support-ack")).toBe(false);
    expect(
      classifyAwaitingSubmitter(row({ replyKind: "support-ack", receivedAt: daysAgo(72) }), NOW)
    ).toBe("not-awaiting");
  });

  it("does NOT own no-url-prose-failed — fault ours, and it is a salvage candidate", () => {
    // Proposed as "the obvious sibling" when this was reopened. It is not:
    // it lives in TERMINAL_UNHANDLED_REPLY_KINDS and is counted by the OPE-17
    // triage notice, so expiring it would remove 14 live rows from the queue
    // PR #1010 built to hold them.
    expect(isAwaitingSubmitterKind("no-url-prose-failed")).toBe(false);
  });

  it("does NOT own unfetchable-url — its own module says the fault is ours", () => {
    expect(isAwaitingSubmitterKind("unfetchable-url")).toBe(false);
  });

  it("does NOT own photo-intake-unresolved — real content, and OPE-254 owns recovery", () => {
    expect(isAwaitingSubmitterKind("photo-intake-unresolved")).toBe(false);
  });
});

describe("the bound", () => {
  it(`expires at ${AWAITING_SUBMITTER_EXPIRY_DAYS} days, per the ruling`, () => {
    expect(AWAITING_SUBMITTER_EXPIRY_DAYS).toBe(21);
    expect(classifyAwaitingSubmitter(row({ receivedAt: daysAgo(22) }), NOW)).toBe("expired");
  });

  it("a row one day inside the window is still waiting", () => {
    expect(classifyAwaitingSubmitter(row({ receivedAt: daysAgo(20) }), NOW)).toBe("waiting");
  });

  it("the boundary is exact — the cutoff instant itself is NOT expired", () => {
    // Caller-supplied `now` exists so this is assertable to the millisecond
    // rather than being approximately right.
    const cutoff = awaitingSubmitterCutoff(NOW);
    expect(classifyAwaitingSubmitter(row({ receivedAt: cutoff }), NOW)).toBe("waiting");
    expect(
      classifyAwaitingSubmitter(row({ receivedAt: new Date(cutoff.getTime() - 1) }), NOW)
    ).toBe("expired");
  });

  it("the 89-day row that motivated the ruling expires", () => {
    expect(classifyAwaitingSubmitter(row({ receivedAt: daysAgo(89) }), NOW)).toBe("expired");
  });
});

describe("expiry never swallows a settled row", () => {
  it("a row that produced an event is not awaiting anyone", () => {
    expect(
      classifyAwaitingSubmitter(row({ receivedAt: daysAgo(99), resultingEventId: "evt-1" }), NOW)
    ).toBe("not-awaiting");
  });

  it.each(["rejected", "audit-noop", "salvaged"])(
    "a row a human disposed of (%s) reads as settled, NOT expired",
    (status) => {
      // Distinguishable from "timed out" on purpose — conflating them would
      // report a resolved row as one nobody answered.
      expect(classifyAwaitingSubmitter(row({ status, receivedAt: daysAgo(99) }), NOW)).toBe(
        "not-awaiting"
      );
    }
  );

  it("a row with no received_at stays WAITING rather than expiring on missing data", () => {
    // Expiring on absent data is how a clean-up quietly eats rows it could not
    // measure. Fail toward keeping it visible.
    expect(classifyAwaitingSubmitter(row({ receivedAt: null }), NOW)).toBe("waiting");
    expect(classifyAwaitingSubmitter(row({ receivedAt: new Date("nonsense") }), NOW)).toBe(
      "waiting"
    );
  });
});

describe("summarise reports both numbers, so a backlog cannot hide behind the bound", () => {
  it("separates waiting from expired and ages the oldest waiter", () => {
    const counts = summariseAwaitingSubmitter(
      [
        row({ receivedAt: daysAgo(1) }),
        row({ receivedAt: daysAgo(14) }),
        row({ receivedAt: daysAgo(30) }),
        row({ receivedAt: daysAgo(89) }),
        row({ replyKind: "support-ack", receivedAt: daysAgo(72) }),
        row({ receivedAt: daysAgo(99), resultingEventId: "evt-2" }),
      ],
      NOW
    );
    expect(counts).toEqual({ waiting: 2, expired: 2, oldestWaitingDays: 14 });
  });

  it("an all-expired queue still reports its expired count, not silence", () => {
    // If expiry made rows vanish, this would read as an empty, healthy queue.
    // The bound working and the queue being empty are different facts.
    const counts = summariseAwaitingSubmitter([row({ receivedAt: daysAgo(60) })], NOW);
    expect(counts.expired).toBe(1);
    expect(counts.waiting).toBe(0);
    expect(counts.oldestWaitingDays).toBeNull();
  });

  it("an empty input is zeros, not a crash", () => {
    expect(summariseAwaitingSubmitter([], NOW)).toEqual({
      waiting: 0,
      expired: 0,
      oldestWaitingDays: null,
    });
  });
});

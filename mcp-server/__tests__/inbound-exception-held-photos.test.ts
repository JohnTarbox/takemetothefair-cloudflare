/**
 * OPE-532 — a held photo-intake email is `status='replied'`, so every counter
 * read it as handled.
 *
 * On 2026-08-23 ten photo submissions landed in eighteen minutes and every one
 * of them held. The 06:00Z run four hours later sent three other alerts and no
 * inbound-exception notice. Two shipped detectors watched ten losses go by.
 *
 * The cause, read from the source rather than inferred: `salvageCandidateWhere`
 * required `status='failed'` AND `intent IN ('new_event','submit')`. A held
 * photo row fails BOTH — its status is 'replied' (the ack sets it) and its
 * intent is 'photo_intake'. Widening only the status would still have missed it.
 *
 * These run the REAL predicate as SQL against real rows, because the defect is
 * precisely that a predicate did not match rows it should have. A test that
 * re-implemented the rule could not have caught it.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { salvageCandidateWhere, __test } from "../src/inbound-exception-notice.js";
import { inboundEmails } from "../src/schema.js";

const { ageBucket, AGE_ESCALATION_DAYS, TERMINAL_UNHANDLED_REPLY_KINDS, DISPOSED_STATUSES } =
  __test;

let db: TestDb;
beforeEach(() => {
  ({ db } = createTestDb());
});

let seq = 0;
async function insertRow(over: Partial<typeof inboundEmails.$inferInsert> = {}) {
  seq += 1;
  await db.insert(inboundEmails).values({
    id: `row-${seq}`,
    fromAddress: "jtarboxme@gmail.com",
    toAddress: "submit@meetmeatthefair.com",
    subject: `subject ${seq}`,
    receivedAt: new Date("2026-08-23T01:30:00Z"),
    createdAt: new Date("2026-08-23T01:30:00Z"),
    ...over,
  } as typeof inboundEmails.$inferInsert);
}

async function candidateCount(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(inboundEmails)
    .where(salvageCandidateWhere);
  return rows[0]?.n ?? 0;
}

describe("the ten held photos are now counted", () => {
  it("counts a held photo-intake row that the ack marked 'replied'", async () => {
    // Exactly the shape of all ten: the row records its own failure as a success.
    await insertRow({
      status: "replied",
      intent: "photo_intake",
      replyKind: "photo-intake-unresolved",
      resultingEventId: null,
    });
    expect(await candidateCount()).toBe(1);
  });

  it("counts all ten of the 2026-08-23 batch", async () => {
    for (let i = 0; i < 10; i++) {
      await insertRow({
        status: "replied",
        intent: "photo_intake",
        replyKind: "photo-intake-unresolved",
        resultingEventId: null,
      });
    }
    expect(await candidateCount()).toBe(10);
  });

  it("does NOT count one that has since resolved — scope 4", async () => {
    // Five of the real ten now carry a resulting_event_id while STILL carrying
    // reply_kind='photo-intake-unresolved'. Keying the queue on the reply kind
    // alone would have counted them for ever.
    await insertRow({
      status: "replied",
      intent: "photo_intake",
      replyKind: "photo-intake-unresolved",
      resultingEventId: "evt-1",
    });
    expect(await candidateCount()).toBe(0);
  });

  it("does NOT count one an operator has explicitly disposed of", async () => {
    // reply_kind is never rewritten on disposal, so without the disposed-status
    // guard a rejected hold would be reported forever.
    for (const status of DISPOSED_STATUSES) {
      await insertRow({
        status,
        intent: "photo_intake",
        replyKind: "photo-intake-unresolved",
        resultingEventId: null,
      });
    }
    expect(await candidateCount()).toBe(0);
  });
});

describe("the other terminal-unhandled states", () => {
  it("counts no-url-prose-failed — content in hand, nothing extracted", async () => {
    await insertRow({
      status: "replied",
      intent: "new_event",
      replyKind: "no-url-prose-failed",
      resultingEventId: null,
    });
    expect(await candidateCount()).toBe(1);
  });

  it("counts a hard-failed photo intake, which the intent allow-list excluded", async () => {
    // One live row, 2026-08-10. status='failed' put it in branch (A)'s reach,
    // but intent='photo_intake' was not in SALVAGE_INTENTS, so nothing saw it.
    await insertRow({ status: "failed", intent: "photo_intake", resultingEventId: null });
    expect(await candidateCount()).toBe(1);
  });

  it("does NOT count no-url — the ball is with the sender, not us", async () => {
    // 13 live rows. Deliberately excluded and enumerated on the ticket rather
    // than folded into a queue whose subject says a human must salvage them.
    await insertRow({
      status: "replied",
      intent: "submit",
      replyKind: "no-url",
      resultingEventId: null,
    });
    expect(await candidateCount()).toBe(0);
  });

  it("does NOT count ordinary acks that closed correctly", async () => {
    for (const [intent, replyKind] of [
      ["support", "support-ack"],
      ["correction", "correction-ack"],
      ["unsubscribe", "unsubscribe-ack"],
      ["source_suggestion", "source-suggestion-ack"],
    ] as const) {
      await insertRow({ status: "replied", intent, replyKind, resultingEventId: null });
    }
    expect(await candidateCount()).toBe(0);
  });

  it("still counts OPE-17's original queue unchanged", async () => {
    await insertRow({ status: "failed", intent: "new_event", resultingEventId: null });
    await insertRow({ status: "failed", intent: "submit", resultingEventId: null });
    expect(await candidateCount()).toBe(2);
  });

  it("still excludes the OPE-74 non-actionable sender loopback", async () => {
    await insertRow({
      fromAddress: "notify@meetmeatthefair.com",
      status: "replied",
      intent: "photo_intake",
      replyKind: "photo-intake-unresolved",
      resultingEventId: null,
    });
    expect(await candidateCount()).toBe(0);
  });
});

describe("ageBucket — a queue that stops draining must not go quiet", () => {
  it("reports the highest threshold crossed", () => {
    expect(ageBucket(0)).toBe(0);
    expect(ageBucket(2)).toBe(0);
    expect(ageBucket(3)).toBe(3);
    expect(ageBucket(6)).toBe(3);
    expect(ageBucket(7)).toBe(7);
    expect(ageBucket(29)).toBe(14);
    expect(ageBucket(365)).toBe(90);
  });

  it("uses widening thresholds so reminders get rarer, not daily", () => {
    const gaps = AGE_ESCALATION_DAYS.slice(1).map(
      (d: number, i: number) => d - AGE_ESCALATION_DAYS[i]
    );
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b));
  });

  it("names the reply kinds it covers", () => {
    expect([...TERMINAL_UNHANDLED_REPLY_KINDS]).toEqual([
      "photo-intake-unresolved",
      "no-url-prose-failed",
    ]);
  });
});

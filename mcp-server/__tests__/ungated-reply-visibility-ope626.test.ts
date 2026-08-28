/**
 * OPE-626 — `reply:*` mail reaching customers on a path the gate cannot see.
 *
 * `EMAIL_REPLY_ENABLED` is enforced in exactly ONE place —
 * `queue-consumers.ts:272` — and only catches mail that BOTH carries a
 * `reply:*` source AND travels through the EMAIL_JOBS queue. The two
 * human-reviewable paths (the admin reply route, the `reply_to_inbound_email`
 * tool) go through the queue and are gated. The highest-volume sender, the
 * inbound workflow's auto-replies, calls `env.EMAIL.send` DIRECTLY.
 *
 * So the flag stops the mail a human reviewed and passes the mail nobody did.
 *
 * ⚠️ This ticket is STOP-gated on changing what SENDS. Nothing here changes
 * send behaviour — it only makes the bypass visible, which the ticket asks for
 * "regardless of the policy chosen".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  shouldReportUngatedReplies,
  readOperatorQueues,
  decideOperatorQueueNotice,
} from "../src/operator-queue-notice.js";

const NOW = new Date("2026-08-28T06:00:00Z");
let db: TestDb;
let raw: { exec: (s: string) => unknown };

let seq = 0;
function seedSend(source: string, hoursAgo: number, status = "sent") {
  const at = Math.floor((NOW.getTime() - hoursAgo * 3600_000) / 1000);
  raw.exec(`
    INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, status, subject)
    VALUES ('m${++seq}', ${at}, 'someone@example.com', '${source}', '${status}', 'Re: your submission')
  `);
}

beforeEach(() => {
  const t = createTestDb();
  db = t.db;
  raw = t.raw as unknown as { exec: (s: string) => unknown };
  seq = 0;
});

describe("shouldReportUngatedReplies", () => {
  it("reports when the flag is OFF and replies went out anyway — the defect", () => {
    expect(shouldReportUngatedReplies(12, "false")).toBe(true);
    expect(shouldReportUngatedReplies(12, undefined)).toBe(true);
    // Anything that is not exactly "true" leaves the gate closed, matching
    // queue-consumers.ts's own `!== "true"` test.
    expect(shouldReportUngatedReplies(12, "TRUE")).toBe(true);
  });

  it("stays SILENT when the flag is on — those sends are intended, not a bypass", () => {
    expect(shouldReportUngatedReplies(12, "true")).toBe(false);
  });

  it("stays silent when nothing was sent", () => {
    expect(shouldReportUngatedReplies(0, "false")).toBe(false);
  });
});

describe("the notice surfaces the bypass", () => {
  it("counts reply:* sends in the last 24h and fires on its own", async () => {
    seedSend("reply:ok-multi", 2);
    seedSend("reply:support-ack", 5);
    // A second DIRECT sender the filing ticket did not name: the stale sweep
    // (`inbound-email-stale-sweep.ts`) also calls env.EMAIL.send and labels its
    // mail `reply:sweep-exceeded`. Counting from the LEDGER rather than
    // instrumenting one send site is what catches it.
    seedSend("reply:sweep-exceeded", 8);

    const counts = await readOperatorQueues(db, NOW, { EMAIL_REPLY_ENABLED: "false" });
    expect(counts.ungatedReplies).toBe(3);
    expect(counts.agedClaims).toBe(0);
    expect(counts.agedReplies).toBe(0);
    // The bypass alone is enough to wake the operator.
    expect(decideOperatorQueueNotice(counts, false)).toBe(true);
    expect(counts.lines.join(" ")).toContain("EMAIL_REPLY_ENABLED");
  });

  it("ignores non-reply sources — a newsletter is not an ungated reply", async () => {
    seedSend("newsletter:weekly-digest", 2);
    seedSend("auth.register", 3);
    const counts = await readOperatorQueues(db, NOW, { EMAIL_REPLY_ENABLED: "false" });
    expect(counts.ungatedReplies).toBe(0);
  });

  it("ignores sends older than 24h — the line is about what went out TODAY", async () => {
    seedSend("reply:ok-multi", 30);
    const counts = await readOperatorQueues(db, NOW, { EMAIL_REPLY_ENABLED: "false" });
    expect(counts.ungatedReplies).toBe(0);
  });

  it("ignores failed sends — nothing reached a customer", async () => {
    seedSend("reply:ok-multi", 2, "failed");
    const counts = await readOperatorQueues(db, NOW, { EMAIL_REPLY_ENABLED: "false" });
    expect(counts.ungatedReplies).toBe(0);
  });

  it("says nothing when the flag is ON", async () => {
    seedSend("reply:ok-multi", 2);
    const counts = await readOperatorQueues(db, NOW, { EMAIL_REPLY_ENABLED: "true" });
    expect(counts.ungatedReplies).toBe(0);
    expect(decideOperatorQueueNotice(counts, false)).toBe(false);
  });

  it("repeats daily while it holds — this is an INVARIANT, not a work queue", async () => {
    // The other three queues deliberately do NOT re-nag: a steady count there
    // means "seen, not yet got to". Here a steady count means unreviewed mail
    // is STILL reaching customers on a path the operator believes is off, so
    // the debounce is the only thing that should ever quiet it.
    seedSend("reply:ok-multi", 2);
    const counts = await readOperatorQueues(db, NOW, { EMAIL_REPLY_ENABLED: "false" });
    expect(decideOperatorQueueNotice(counts, false)).toBe(true);
    // …and only the once-per-day debounce holds it back.
    expect(decideOperatorQueueNotice(counts, true)).toBe(false);
  });
});

/**
 * OPE-599 — a waiting operator queue must reach the operator.
 *
 * Kenneth Soares claimed `gooseberry-leather-company` on 2026-07-22 and offered
 * to verify from his business domain. Nobody asked. The claim sat PENDING for
 * 36 days in a table that held TWO ROWS IN ITS ENTIRE HISTORY, and was found
 * only because an unrelated sweep happened to read it.
 *
 * `list_claims` works. It is passive — an admin has to think to call it — and
 * "a queue you can query on request" is not surfacing.
 *
 * These seed REAL BACKDATED ROWS and run the whole path against an in-memory
 * database with a capturing queue, per the acceptance criterion: not a mocked
 * clock reading, and not an assertion that the parameter exists.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  checkOperatorQueues,
  decideOperatorQueueNotice,
  readOperatorQueues,
  NOTICE_EMAIL_SOURCE,
  QUEUE_SLA_HOURS,
} from "../src/operator-queue-notice.js";
import { emailSendLedger } from "../src/schema.js";

const NOW = new Date("2026-08-28T06:00:00Z");
const DAY = 86400_000;

interface SentMail {
  to: string;
  subject: string;
  text: string;
  source: string;
}

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let sent: SentMail[];
let env: Parameters<typeof checkOperatorQueues>[1];

beforeEach(() => {
  ({ db, raw } = createTestDb());
  // entity_claims.user_id is NOT NULL — the claimant is the point of the row.
  raw["prepare"](
    `INSERT INTO users (id, email, name, role) VALUES ('u-ken','kenneth@gooseberryleather.com','Kenneth Soares','VENDOR')`
  ).run();
  sent = [];
  env = {
    ALERT_EMAIL_TECHNICAL: "ops@example.com",
    EMAIL_JOBS: {
      send: async (m: SentMail) => {
        sent.push(m);
      },
    },
  } as unknown as Parameters<typeof checkOperatorQueues>[1];
});

/** A real claim row, backdated by `ageDays`. */
function seedClaim(id: string, status: string, ageDays: number, decided = false) {
  raw["prepare"](
    `INSERT INTO entity_claims (id, entity_type, entity_id, user_id, method, status, created_at, decided_at)
     VALUES (?, 'VENDOR', 'gooseberry-leather-company', 'u-ken', 'email_domain', ?, ?, ?)`
  ).run(id, status, Math.floor((NOW.getTime() - ageDays * DAY) / 1000), decided ? 1 : null);
}

function seedReply(id: string, status: string, ageDays: number) {
  raw["prepare"](
    `INSERT INTO pending_email_replies (id, inbound_email_id, to_address, subject, body_text, requested_at, status)
     VALUES (?, 'ie-1', 'someone@example.com', 'Re: your fair', 'body', ?, ?)`
  ).run(id, Math.floor((NOW.getTime() - ageDays * DAY) / 1000), status);
}

describe("decideOperatorQueueNotice", () => {
  it("is SILENT on an empty queue — the property that keeps it from becoming wallpaper", () => {
    expect(decideOperatorQueueNotice({ agedClaims: 0, agedReplies: 0 }, false)).toBe(false);
  });

  it("fires when something is waiting", () => {
    expect(decideOperatorQueueNotice({ agedClaims: 1, agedReplies: 0 }, false)).toBe(true);
    expect(decideOperatorQueueNotice({ agedClaims: 0, agedReplies: 1 }, false)).toBe(true);
  });

  it("sends at most once a day", () => {
    expect(decideOperatorQueueNotice({ agedClaims: 3, agedReplies: 2 }, true)).toBe(false);
  });
});

describe("the notice, end to end, on real backdated rows", () => {
  it("alerts on Kenneth's shape — a PENDING claim aged past the SLA", async () => {
    seedClaim("c-1", "PENDING", 36);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@example.com");
    expect(sent[0].source).toBe(NOTICE_EMAIL_SOURCE);
    // The operator must be able to act without going and looking it up.
    expect(sent[0].text).toContain("gooseberry-leather-company");
    expect(sent[0].text).toContain("36d");
  });

  it("says nothing at all when both queues are clear", async () => {
    // The live state today: entity_claims holds 2 APPROVED rows and
    // pending_email_replies holds 1 approved + 3 discarded. Zero waiting.
    seedClaim("c-ok", "APPROVED", 40, true);
    seedReply("r-ok", "discarded", 20);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(0);
  });

  it("ignores a claim younger than the SLA", async () => {
    seedClaim("c-new", "PENDING", QUEUE_SLA_HOURS / 24 - 0.5);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(0);
  });

  it("covers DISPUTED as well as PENDING — both are undecided", async () => {
    seedClaim("c-d", "DISPUTED", 10);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(1);
  });

  it("alerts on a stranded reply draft, the other half of the family", async () => {
    // Four of these were written to real people and never delivered, for the
    // same reason: no notifier.
    seedReply("r-1", "pending", 9);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("someone@example.com");
  });

  it("counts both queues in one message rather than two mails", async () => {
    seedClaim("c-1", "PENDING", 36);
    seedReply("r-1", "pending", 9);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("2 operator queue items");
  });

  it("does not re-send on the same UTC day", async () => {
    seedClaim("c-1", "PENDING", 36);
    await db.insert(emailSendLedger).values({
      messageId: "sent-today",
      sentAt: new Date("2026-08-28T00:05:00Z"),
      recipient: "ops@example.com",
      source: NOTICE_EMAIL_SOURCE,
      status: "sent",
    });
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(0);
  });

  it("sends again the next day while the item is still undecided", async () => {
    // "Exactly one alert per day until decided" — the acceptance wording.
    seedClaim("c-1", "PENDING", 36);
    await db.insert(emailSendLedger).values({
      messageId: "sent-yesterday",
      sentAt: new Date("2026-08-27T06:00:00Z"),
      recipient: "ops@example.com",
      source: NOTICE_EMAIL_SOURCE,
      status: "sent",
    });
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(1);
  });

  it("reports the same numbers the data-health report shows", async () => {
    // The report and the alert read through one function, so they cannot
    // disagree about what is waiting — which is how "the dashboard says clear"
    // and "the queue is full" coexist.
    seedClaim("c-1", "PENDING", 36);
    seedReply("r-1", "pending", 9);
    const q = await readOperatorQueues(db, NOW);
    expect(q.agedClaims).toBe(1);
    expect(q.agedReplies).toBe(1);
    expect(q.oldestDays).toBe(36);
  });
});

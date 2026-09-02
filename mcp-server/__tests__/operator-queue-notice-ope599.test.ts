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
import { readFile } from "node:fs/promises";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  checkOperatorQueues,
  decideOperatorQueueNotice,
  readOperatorQueues,
  NOTICE_EMAIL_SOURCE,
  QUEUE_SLA_HOURS,
  ADMIN_DECISION_TIMEOUT_HOURS,
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

/**
 * OPE-761 — the fifth queue: inbound mail hibernating on the workflow's
 * `admin-decision` pause.
 *
 * Jeremy Hall (Assistant Division Director, CT DEEP) wrote to `hello@` on
 * 2026-09-02 and got five hours of silence; `advisor@flippa.com`'s `press` row
 * sat two days. Both were CORRECTLY parked — the routing worked. Nothing
 * announced them, and the clock they are on ends in a generic auto-ack rather
 * than an answer.
 */
describe("OPE-761 — inbound awaiting admin decision", () => {
  /** Seed an inbound row `ageHours` old, parked in `waiting`. */
  function seedWaiting(id: string, intent: string, ageHours: number, from = "jeremy.hall@ct.gov") {
    raw["prepare"](
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, status, created_at)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', ?, ?, 'waiting', ?)`
    ).run(
      id,
      Math.floor((NOW.getTime() - ageHours * 3600_000) / 1000),
      from,
      `Subject for ${id}`,
      intent,
      Math.floor((NOW.getTime() - ageHours * 3600_000) / 1000)
    );
  }

  it("stays SILENT when a waiting row is younger than the SLA", async () => {
    // The landmark for every assertion below. Without it, a version that
    // simply counts every `waiting` row passes the aging tests too — and the
    // wallpaper failure is the one this whole file exists to avoid.
    seedWaiting("i-fresh", "correction", QUEUE_SLA_HOURS - 1);
    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(0);
  });

  it("alerts on Jeremy's shape — a `correction` parked past the SLA", async () => {
    seedWaiting("i-jeremy", "correction", 72);
    await checkOperatorQueues(db, env, NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("jeremy.hall@ct.gov");
    expect(sent[0].text).toContain("correction");
  });

  it("alerts on specimen B's shape too — `press`, the intent with no handler", async () => {
    // The acceptance criterion is that ANY intent with no handler can no longer
    // sit unannounced. Reading `status='waiting'` rather than an allow-list of
    // intents is what makes that true for the next lane as well as this one.
    seedWaiting("i-flippa", "press", 50, "advisor@flippa.com");
    await checkOperatorQueues(db, env, NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("advisor@flippa.com");
  });

  it("reports hours REMAINING before the auto-ack cliff, not just age", async () => {
    // Depth cannot show a row approaching the cliff, and the cliff is where the
    // loss happens: at ADMIN_DECISION_TIMEOUT_HOURS the sender is posted a
    // generic ack and the thing they wrote in about is never answered.
    seedWaiting("i-approaching", "correction", ADMIN_DECISION_TIMEOUT_HOURS - 10);
    await checkOperatorQueues(db, env, NOW);

    expect(sent[0].text).toContain("auto-ack in 10h");
  });

  it("says PAST THE CLIFF rather than counting down past zero", async () => {
    // "expires in -14h" would be both wrong and quietly reassuring. A row on
    // the far side of the cliff is the worst case, not a stale one: it has
    // stopped looking unanswered without having been answered.
    seedWaiting("i-expired", "correction", ADMIN_DECISION_TIMEOUT_HOURS + 14);
    await checkOperatorQueues(db, env, NOW);

    expect(sent[0].text).toContain("PAST the 168h cliff");
    expect(sent[0].text).not.toContain("auto-ack in -");
  });

  it("ignores rows that are not in `waiting` — a replied row is not a queue item", async () => {
    raw["prepare"](
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, status, created_at)
       VALUES ('i-done', ?, 'x@y.com', 'hello@meetmeatthefair.com', 'done', 'correction', 'replied', ?)`
    ).run(
      Math.floor((NOW.getTime() - 30 * 86400_000) / 1000),
      Math.floor((NOW.getTime() - 30 * 86400_000) / 1000)
    );

    await checkOperatorQueues(db, env, NOW);
    expect(sent).toHaveLength(0);
  });

  it("keeps the constant in step with the workflow's actual timeout", async () => {
    // The comment on ADMIN_DECISION_TIMEOUT_HOURS claims it mirrors the
    // workflow's `timeout: "7 days"`. That claim has to be a control, not a
    // note: the two live in different modules, and a silent drift would make
    // every countdown in the notice wrong while everything still passed.
    const src = await readFile(
      new URL("../src/workflows/inbound-email.ts", import.meta.url),
      "utf8"
    );
    const m = src.match(/waitForEvent<AdminDecision>\([\s\S]{0,200}?timeout:\s*"([^"]+)"/);
    expect(
      m,
      "could not find the admin-decision waitForEvent timeout in the workflow"
    ).toBeTruthy();
    expect(m![1]).toBe("7 days");
    expect(ADMIN_DECISION_TIMEOUT_HOURS).toBe(7 * 24);
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

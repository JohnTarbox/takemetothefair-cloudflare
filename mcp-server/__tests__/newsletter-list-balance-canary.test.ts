/**
 * OPE-510 §3 — the canary must be OBSERVED FIRING on an induced imbalance.
 *
 * That wording is the acceptance criterion verbatim, and it is there because
 * the previous ship satisfied every weaker version of it. The balance QUERY
 * shipped in PR #996 with 15 passing tests. What it did not have was a caller
 * on a schedule and an alert, so when a real imbalance appeared — four public
 * double-opt-in signups confirmed between the 08-21 backfill and the writer's
 * deploy — it sat undetected for five to seven days and was found by hand.
 *
 * So these tests exercise the whole path with a real (in-memory) database and a
 * capturing queue: induce the imbalance, run the scheduled entry point, and
 * assert an operator alert was actually enqueued. A test of `listBalance` alone
 * would have passed on 08-21 too.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  checkNewsletterListBalance,
  decideListBalanceAlert,
  CANARY_EMAIL_SOURCE,
} from "../src/newsletter-list-balance-canary.js";
import { agentHeartbeats, emailSendLedger } from "../src/schema.js";
import { eq } from "drizzle-orm";

const NOW = new Date("2026-08-28T06:00:00Z");

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  source: string;
}

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
let sent: SentMail[];
let env: Parameters<typeof checkNewsletterListBalance>[1];

/** A confirmed, non-unsubscribed subscriber — with or without a list row. */
function addSubscriber(id: string, email: string, opts: { onList: boolean }) {
  raw["prepare"](
    `INSERT INTO newsletter_subscribers (id, email, source, confirmed, unsubscribed, created_at)
     VALUES (?, ?, 'footer', 1, 0, 1787000000)`
  ).run(id, email);
  if (opts.onList) {
    raw["prepare"](
      `INSERT INTO newsletter_list_subscriptions (id, subscriber_id, list, created_at)
       VALUES (?, ?, 'weekend', 1787000000)`
    ).run(`l-${id}`, id);
  }
}

beforeEach(() => {
  ({ db, raw } = createTestDb());
  sent = [];
  env = {
    DB: db,
    ALERT_EMAIL_TECHNICAL: "ops@example.com",
    EMAIL_JOBS: {
      send: async (m: SentMail) => {
        sent.push(m);
      },
    },
  } as unknown as Parameters<typeof checkNewsletterListBalance>[1];
});

describe("decideListBalanceAlert — the debounce, and what it deliberately omits", () => {
  it("stays silent when balanced", () => {
    expect(decideListBalanceAlert(0, false)).toBe(false);
  });

  it("fires on the first orphan of the day", () => {
    expect(decideListBalanceAlert(4, false)).toBe(true);
  });

  it("does not send twice in one day", () => {
    expect(decideListBalanceAlert(4, true)).toBe(false);
  });

  it("KEEPS firing on an UNCHANGED orphan count the next day", () => {
    // The sharp edge, and the reason this function does not take a previous
    // count at all. Every sibling notice in this worker debounces on "quiet
    // unless the number changed", which is right for a backlog and wrong for
    // an invariant: a steady 4 is four people who have now gone another day
    // receiving nothing.
    //
    // It is also the original defect's own shape — the weekend list had 17
    // members the morning of its backfill and still had 17 a week later, and a
    // number that never moves looks exactly like a number nothing writes to.
    expect(decideListBalanceAlert(4, false)).toBe(true);
  });
});

describe("the canary, end to end, on an induced imbalance", () => {
  it("alerts, and names the people", async () => {
    addSubscriber("s-1", "mailed@example.com", { onList: true });
    addSubscriber("s-2", "orphan-a@example.com", { onList: false });
    addSubscriber("s-3", "orphan-b@example.com", { onList: false });

    await checkNewsletterListBalance(db, env, NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@example.com");
    expect(sent[0].source).toBe(CANARY_EMAIL_SOURCE);
    expect(sent[0].subject).toContain("2 confirmed subscribers");
    // An operator cannot act on "orphaned=2"; the remedy is per-address.
    expect(sent[0].text).toContain("orphan-a@example.com");
    expect(sent[0].text).toContain("orphan-b@example.com");
    expect(sent[0].text).not.toContain("mailed@example.com");
  });

  it("says nothing when every confirmed subscriber is on a list", async () => {
    addSubscriber("s-1", "a@example.com", { onList: true });
    addSubscriber("s-2", "b@example.com", { onList: true });

    await checkNewsletterListBalance(db, env, NOW);

    expect(sent).toHaveLength(0);
  });

  it("ignores unconfirmed and unsubscribed people — they are owed nothing", async () => {
    raw["prepare"](
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, created_at)
       VALUES ('s-u', 'unconfirmed@example.com', 0, 0, 1787000000)`
    ).run();
    raw["prepare"](
      `INSERT INTO newsletter_subscribers (id, email, confirmed, unsubscribed, created_at)
       VALUES ('s-x', 'left@example.com', 1, 1, 1787000000)`
    ).run();

    await checkNewsletterListBalance(db, env, NOW);

    // Neither is an orphan: one never opted in, the other opted out.
    expect(sent).toHaveLength(0);
  });

  it("stamps the run even on a healthy day — the probe's whole point", async () => {
    addSubscriber("s-1", "a@example.com", { onList: true });

    await checkNewsletterListBalance(db, env, NOW);

    const [stamp] = await db
      .select()
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.agentCode, "watchdog:newsletter-list-balance"));
    // Silence is the healthy state here, so without this stamp "balanced" and
    // "cron dead" are the same row count — which is exactly how the query sat
    // uninvoked for weeks.
    expect(stamp).toBeTruthy();
    expect(stamp.note).toContain("orphaned=0");
  });

  it("does not nag twice on the same UTC day", async () => {
    addSubscriber("s-2", "orphan@example.com", { onList: false });
    // A ledgered send earlier today, as the real mailer would leave.
    await db.insert(emailSendLedger).values({
      messageId: "already-sent-today",
      sentAt: new Date("2026-08-28T00:05:00Z"),
      recipient: "ops@example.com",
      source: CANARY_EMAIL_SOURCE,
      status: "sent",
    });

    await checkNewsletterListBalance(db, env, NOW);

    expect(sent).toHaveLength(0);
  });

  it("nags again the NEXT day while the orphan is still stranded", async () => {
    addSubscriber("s-2", "orphan@example.com", { onList: false });
    await db.insert(emailSendLedger).values({
      messageId: "sent-yesterday",
      sentAt: new Date("2026-08-27T06:00:00Z"),
      recipient: "ops@example.com",
      source: CANARY_EMAIL_SOURCE,
      status: "sent",
    });

    await checkNewsletterListBalance(db, env, NOW);

    // Yesterday's nag must not buy silence today. This is the case that
    // separates a canary from a one-shot notification.
    expect(sent).toHaveLength(1);
  });

  it("a FAILED send yesterday does not count as having alerted", async () => {
    addSubscriber("s-2", "orphan@example.com", { onList: false });
    await db.insert(emailSendLedger).values({
      messageId: "failed-today",
      sentAt: new Date("2026-08-28T00:05:00Z"),
      recipient: "ops@example.com",
      source: CANARY_EMAIL_SOURCE,
      status: "failed",
    });

    await checkNewsletterListBalance(db, env, NOW);

    // The debounce asks "was the operator told?", not "did we try".
    expect(sent).toHaveLength(1);
  });
});

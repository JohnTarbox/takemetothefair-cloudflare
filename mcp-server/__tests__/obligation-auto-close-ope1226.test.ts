/**
 * OPE-1226 — answering a person closes the obligation to answer them, and ONLY
 * that conversation's: the message replied to or its thread. A reply to the
 * same person on a different thread must leave that obligation open.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import { inboundEmails, supportObligations } from "../src/schema.js";
import { handleReplyToInbound } from "../src/tools/reply-to-inbound-email.js";
import { AUTO_CLOSED_BY, closeObligationsAnsweredBy } from "../src/support-obligations-close.js";

/** Generated from the schema, as obligation-lanes-ope1066 does, so it cannot drift. */
function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    const unique = (c as unknown as { isUnique?: boolean }).isUnique ? " UNIQUE" : "";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}${unique}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
const T = 1790500000;

function inbound(id: string, threadId: string | null, from = "pat@example.com") {
  db.insert(inboundEmails)
    .values({
      id,
      receivedAt: new Date(T * 1000),
      createdAt: new Date(T * 1000),
      fromAddress: from,
      toAddress: "support@meetmeatthefair.com",
      subject: `msg ${id}`,
      intent: "support",
      status: "received",
      threadId,
      messageId: `<${id}@mail.example.com>`,
    } as never)
    .run();
}
function obligation(id: string, inboundId: string, from = "pat@example.com") {
  db.insert(supportObligations)
    .values({
      id,
      inboundEmailId: inboundId,
      fromAddress: from,
      subject: "s",
      openedAt: new Date(T * 1000),
      status: "open",
    } as never)
    .run();
}
const statusOf = (id: string) =>
  db.select().from(supportObligations).where(eq(supportObligations.id, id)).all()[0];

const queue = () => ({ send: async () => {} });
const enabled = { emailJobs: queue(), replyEnabled: true, actorUserId: "admin-1" };

// OPE-1252 — the close now runs in the email-jobs consumer once the send is
// confirmed (see obligation-close-on-send-ope1252.test.ts); the conversation
// scoping it applies is tested here on the shared closer directly.
describe("closing an answered conversation's obligations (scope)", () => {
  beforeEach(() => {
    ({ db, raw } = createTestDb());
    raw["exec"](ddlFor(supportObligations));
    inbound("a", "t1");
    inbound("b", "t1");
    inbound("c", "t2");
    obligation("oa", "a");
    obligation("ob", "b");
    obligation("oc", "c");
  });

  it("closes the replied-to message's obligation and the same-thread one", async () => {
    expect(await closeObligationsAnsweredBy(db as never, "a", "note")).toBe(2);
    for (const id of ["oa", "ob"]) {
      expect(statusOf(id)).toMatchObject({ status: "answered", closedBy: AUTO_CLOSED_BY });
    }
  });

  it("leaves the same person's obligation on ANOTHER thread open", async () => {
    await closeObligationsAnsweredBy(db as never, "a", "note");
    expect(statusOf("oc").status).toBe("open");
  });

  it("an already-closed obligation is not rewritten", async () => {
    raw["prepare"](
      "UPDATE support_obligations SET status='not_an_obligation', closed_by='john' WHERE id='ob'"
    ).run();
    expect(await closeObligationsAnsweredBy(db as never, "a", "note")).toBe(1);
    expect(statusOf("ob")).toMatchObject({ status: "not_an_obligation", closedBy: "john" });
  });

  it("a message with no thread closes only its own obligation", async () => {
    inbound("d", null);
    inbound("e", null);
    obligation("od", "d");
    obligation("oe", "e");
    await closeObligationsAnsweredBy(db as never, "d", "note");
    expect(statusOf("od").status).toBe("answered");
    expect(statusOf("oe").status).toBe("open");
  });
});

describe("OPE-1252 — queuing a reply closes nothing", () => {
  it("the obligation is still open after reply_to_inbound_email returns", async () => {
    ({ db, raw } = createTestDb());
    raw["exec"](ddlFor(supportObligations));
    inbound("a", "t1");
    obligation("oa", "a");
    const res = await handleReplyToInbound(db as never, enabled, {
      inboundEmailId: "a",
      body: "Hi",
    });
    expect(res).toMatchObject({ ok: true });
    expect(statusOf("oa").status).toBe("open");
  });
});

describe("0338 backfill — same rule, applied to what is already answered", () => {
  const SQL = readFileSync(
    join(__dirname, "../../drizzle/0338_ope1226_close_answered_support_obligations.sql"),
    "utf8"
  );
  const sent = (
    key: string,
    inboundId: string,
    at: number,
    source = "reply:manual",
    status = "sent",
    recipient = "pat@example.com"
  ) =>
    raw["prepare"](
      "INSERT INTO email_send_ledger (message_id, sent_at, source, status, inbound_email_id, recipient) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(key, at, source, status, inboundId, recipient);

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    raw["exec"](ddlFor(supportObligations));
    inbound("exact", "t1");
    inbound("thread-owed", "t2");
    inbound("thread-answered", "t2");
    inbound("person-only", "t3");
    inbound("other-conv", "t4");
    inbound("early", "t5");
    inbound("failed", "t6");
    inbound("gmail", "t7");
    for (const id of ["exact", "thread-owed", "person-only", "early", "failed", "gmail"]) {
      obligation(`o-${id}`, id);
    }
    sent("s1", "exact", T + 60);
    sent("s2", "thread-answered", T + 60);
    sent("s3", "other-conv", T + 60); // same recipient, different conversation
    sent("s4", "early", T - 60); // before the obligation opened
    sent("s5", "failed", T + 60, "reply:manual", "failed");
    sent("s6", "gmail", T + 60, "reply:manual-gmail");
    sent("s7", "person-only", T + 60, "reply:support-ack"); // automated, not a person
  });

  it("closes exact-message and same-thread answers; nothing else", () => {
    raw["exec"](SQL);
    const s = (id: string) => statusOf(`o-${id}`).status;
    expect(s("exact")).toBe("answered");
    expect(s("thread-owed")).toBe("answered");
    expect(s("gmail")).toBe("answered");
    expect(s("person-only")).toBe("open");
    expect(s("early")).toBe("open");
    expect(s("failed")).toBe("open");
  });

  it("a re-run changes nothing", () => {
    const run = () => raw["prepare"](SQL.replace(/--[^\n]*\n/g, "")).run().changes;
    expect(run()).toBe(3);
    expect(run()).toBe(0);
  });
});

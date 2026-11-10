/**
 * OPE-1510 — the contact-mail lane: a known contact gets no automatic ack, one
 * obligation with a one-business-day target, and one draft for John to approve.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup-db.js";
import {
  emailSendLedger,
  inboundEmails,
  operatorOutboundDrafts,
  promoters,
  promoterContacts,
  supportObligations,
  adminActions,
  events,
  users,
} from "../src/schema.js";
import {
  composeContactDraft,
  CONTACT_LANE_ACK_KINDS,
  firstNameFrom,
  runContactLane,
} from "../src/inbound/contact-lane.js";
import { contactObligationTarget, isBusinessDay } from "../src/inbound/business-days.js";
import { resolveKnownContact } from "../src/inbound/known-contact.js";
import { closeObligationsAnsweredBy, shouldCloseOnSend } from "../src/support-obligations-close.js";
import { registerSupportObligationTools } from "../src/tools/admin-support-obligations.js";
import { registerOperatorOutboundTools } from "../src/tools/admin-operator-outbound.js";
import { readOperatorQueues } from "../src/operator-queue-notice.js";

function ddlFor(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const type = c.getSQLType().toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    const unique = (c as unknown as { isUnique?: boolean }).isUnique ? " UNIQUE" : "";
    const dflt =
      c.name === "status" ? " DEFAULT 'open'" : c.name === "kind" ? " DEFAULT 'support'" : "";
    return `  ${c.name} ${type}${c.primary ? " PRIMARY KEY" : ""}${unique}${dflt}`;
  });
  return `CREATE TABLE ${cfg.name} (\n${cols.join(",\n")}\n);`;
}

let db: TestDb;
let raw: ReturnType<typeof createTestDb>["raw"];
// Tuesday 2026-11-10, 16:00 UTC.
const T = new Date("2026-11-10T16:00:00Z");
const DEBRA = "debra@example.org";

function inbound(id: string, over: Partial<typeof inboundEmails.$inferInsert> = {}) {
  db.insert(inboundEmails)
    .values({
      id,
      receivedAt: T,
      createdAt: T,
      fromAddress: DEBRA,
      fromDisplayName: "Debra Gallo",
      toAddress: "support@meetmeatthefair.com",
      subject: "Thanksgiving show dates",
      intent: "correction",
      status: "received",
      classifiedIntent: "correction",
      classifiedConfidence: 0.9,
      threadId: "thread-1",
      ...over,
    } as typeof inboundEmails.$inferInsert)
    .run();
}

function promoter(id = "p1", contactEmail: string | null = null) {
  db.insert(promoters)
    .values({
      id,
      userId: "u1",
      companyName: "USA Thanksgiving",
      slug: `usa-thanksgiving-${id}`,
      contactEmail,
      createdAt: T,
      updatedAt: T,
    } as unknown as typeof promoters.$inferInsert)
    .run();
}

function contact(status: "candidate" | "validated" | "rejected", promoterId = "p1") {
  db.insert(promoterContacts)
    .values({
      id: crypto.randomUUID(),
      promoterId,
      email: DEBRA,
      name: "Debra Gallo",
      validationMethod: "replied_to_our_mail",
      status,
      createdAt: T,
      updatedAt: T,
    })
    .run();
}

const lane = (id: string, replyKind: Parameters<typeof runContactLane>[1]["replyKind"]) =>
  runContactLane(db as never, {
    messageRowId: id,
    replyKind,
    replyAlreadySuppressed: false,
    closedBySender: false,
    isNewsletter: false,
    now: T,
  });

const obligations = () => db.select().from(supportObligations).all();
const drafts = () => db.select().from(operatorOutboundDrafts).all();
const ledger = () => db.select().from(emailSendLedger).all();

beforeEach(() => {
  const t = createTestDb();
  db = t.db as unknown as TestDb;
  raw = t.raw;
  raw.exec(`DROP TABLE IF EXISTS support_obligations;\n${ddlFor(supportObligations)}`);
  raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ob ON support_obligations(inbound_email_id);`);
  db.insert(users)
    .values({ id: "u1", email: "owner@example.net", createdAt: T, updatedAt: T } as never)
    .run();
});

describe("known contact", () => {
  it("a candidate promoter contact is known", async () => {
    promoter();
    contact("candidate");
    expect((await resolveKnownContact(db as never, DEBRA))?.basis).toBe("promoter-contact");
  });

  it("a rejected contact is unknown, even with the address stored on the promoter", async () => {
    promoter("p1", DEBRA);
    contact("rejected");
    expect(await resolveKnownContact(db as never, DEBRA)).toBeNull();
  });

  it("a stored promoter email is known, case-insensitively", async () => {
    promoter("p1", "Debra@Example.org");
    expect((await resolveKnownContact(db as never, DEBRA))?.basis).toBe("promoter-contact-email");
  });

  it("never treats the operator as a contact, even with the address stored", async () => {
    promoter("p1", "jtarboxme@gmail.com");
    expect(await resolveKnownContact(db as never, "jtarboxme+x@gmail.com")).toBeNull();
  });
});

describe("the lane", () => {
  it("Debra's shape: three inbound rows open one obligation and one draft, and no ack", async () => {
    promoter();
    contact("candidate");
    inbound("parent", { intent: "multi", classifiedIntent: "multi" });
    inbound("child-a", { parentEmailId: "parent" });
    inbound("child-b", { parentEmailId: "parent", intent: "source_suggestion" });

    const a = await lane("child-a", "correction-ack");
    const b = await lane("child-b", "source-suggestion-ack");

    expect(a.fired && b.fired).toBe(true);
    const obs = obligations();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ kind: "contact", inboundEmailId: "parent", status: "open" });
    expect(obs[0].targetAt?.toISOString()).toBe(contactObligationTarget(T).toISOString());
    const ds = drafts();
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      toAddress: DEBRA,
      status: "pending",
      inboundEmailId: "parent",
      relatedEntityType: "promoter",
      subject: "Re: Thanksgiving show dates",
    });
    expect(ds[0].bodyText).toContain("Hello Debra,");
    // Withheld acks are stubbed. No row in the ledger says `sent`.
    expect(ledger().map((l) => l.status)).toEqual(["stubbed", "stubbed"]);
    expect(ledger().some((l) => l.status === "sent")).toBe(false);
    // Basis recorded on the row.
    const [row] = db.select().from(inboundEmails).where(eq(inboundEmails.id, "child-a")).all();
    expect(row.knownContactBasis).toBe("promoter-contact");
    expect(row.knownContactEntityId).toBe("p1");
  });

  it("is idempotent across a Workflow retry", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    await lane("m1", "correction-ack");
    await lane("m1", "correction-ack");
    expect(obligations()).toHaveLength(1);
    expect(drafts()).toHaveLength(1);
  });

  it("an unknown sender is untouched", async () => {
    inbound("m1");
    const r = await lane("m1", "correction-ack");
    expect(r).toMatchObject({ fired: false, skip: "unknown-sender" });
    expect(obligations()).toHaveLength(0);
    expect(drafts()).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
    const [row] = db.select().from(inboundEmails).all();
    expect(row.knownContactBasis).toBeNull();
  });

  it("a rejected contact behaves as an unknown sender", async () => {
    promoter();
    contact("rejected");
    inbound("m1");
    expect((await lane("m1", "support-ack")).fired).toBe(false);
    expect(drafts()).toHaveLength(0);
  });

  it("a reply that is not a generic ack does not fire, but the basis is still recorded", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    const r = await lane("m1", "ok");
    expect(r).toMatchObject({ fired: false, skip: "not-a-generic-ack" });
    expect(obligations()).toHaveLength(0);
    const [row] = db.select().from(inboundEmails).all();
    expect(row.knownContactBasis).toBe("promoter-contact");
  });

  it.each(CONTACT_LANE_ACK_KINDS)("suppresses %s", async (kind) => {
    promoter();
    contact("validated");
    inbound("m1");
    expect((await lane("m1", kind)).fired).toBe(true);
  });

  it("a thanks-only close, a newsletter and a zero-confidence unclear do not fire", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    const closed = await runContactLane(db as never, {
      messageRowId: "m1",
      replyKind: "correction-ack",
      replyAlreadySuppressed: false,
      closedBySender: true,
      isNewsletter: false,
      now: T,
    });
    expect(closed.skip).toBe("conversation-closed");
    const news = await runContactLane(db as never, {
      messageRowId: "m1",
      replyKind: "correction-ack",
      replyAlreadySuppressed: false,
      closedBySender: false,
      isNewsletter: true,
      now: T,
    });
    expect(news.skip).toBe("newsletter");
    inbound("m2", { classifiedIntent: "unclear", classifiedConfidence: 0 });
    expect((await lane("m2", "support-ack")).skip).toBe("zero-confidence-unclear");
    expect(obligations()).toHaveLength(0);
  });

  it("converts an obligation a handler already opened, so one message still owes one reply", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    db.insert(supportObligations)
      .values({ id: "ob1", inboundEmailId: "m1", fromAddress: DEBRA, openedAt: T, status: "open" })
      .run();
    await lane("m1", "correction-ack");
    const obs = obligations();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ id: "ob1", kind: "contact", status: "open" });
    expect(obs[0].targetAt).not.toBeNull();
  });

  it("a later message on the thread joins the open obligation and queues no second draft", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    inbound("m2");
    await lane("m1", "correction-ack");
    await lane("m2", "thread-reply-ack");
    expect(obligations()).toHaveLength(1);
    expect(drafts()).toHaveLength(1);
  });

  it("a replay of an already-answered message owes nothing new", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    await lane("m1", "correction-ack");
    db.update(supportObligations).set({ status: "answered" }).run();
    db.delete(operatorOutboundDrafts).run();
    const again = await lane("m1", "correction-ack");
    expect(again.fired).toBe(true);
    expect(drafts()).toHaveLength(0);
  });

  it("a fan-out loser ledgers nothing, because it had no ack of its own", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    await runContactLane(db as never, {
      messageRowId: "m1",
      replyKind: "correction-ack",
      replyAlreadySuppressed: true,
      closedBySender: false,
      isNewsletter: false,
      now: T,
    });
    expect(ledger()).toHaveLength(0);
    expect(drafts()).toHaveLength(1);
  });

  it("the draft says what changed and names the conflict, from the OPE-1506 audit row", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    db.insert(events)
      .values({
        id: "e1",
        name: "USA Thanksgiving Show",
        slug: "usa-thanksgiving-show",
        promoterId: "p1",
        createdAt: T,
        updatedAt: T,
      } as never)
      .run();
    db.insert(adminActions)
      .values({
        action: "dedup.enrich_applied",
        targetType: "event",
        targetId: "e1",
        payloadJson: JSON.stringify({
          inboundEmailId: "m1",
          fields: [
            {
              field: "vendor_fee_min_cents",
              old: 7500,
              new: 9000,
              overwrote: true,
              conflictWithSourceUrl: "https://usathanks.example/vendors",
            },
          ],
        }),
        createdAt: T,
      } as never)
      .run();
    await lane("m1", "correction-ack");
    const [d] = drafts();
    expect(d.bodyText).toBe(
      [
        "Hello Debra,",
        "Thank you for writing.",
        "I've updated USA Thanksgiving Show on Meet Me at the Fair with what you sent:\n– Vendor fee min: $90.00 (was $75.00)\nhttps://meetmeatthefair.com/events/usa-thanksgiving-show",
        "Your page at https://usathanks.example/vendors still shows $75.00. You may want to update it so the two match.",
        "John\nhttps://meetmeatthefair.com",
      ].join("\n\n")
    );
  });
});

describe("the template", () => {
  it("is the approved text when nothing was applied", () => {
    expect(
      composeContactDraft({ subject: "Booth question", firstName: null, listings: [] })
    ).toEqual({
      subject: "Re: Booth question",
      bodyText:
        "Hello,\n\nThank you for writing.\n\nI've read your note and will follow up if I need anything more.\n\nJohn\nhttps://meetmeatthefair.com",
    });
  });

  it("keeps a subject already marked as a reply", () => {
    expect(composeContactDraft({ subject: "RE: x", firstName: "A", listings: [] }).subject).toBe(
      "RE: x"
    );
  });

  it("does not take an organisation name for a first name", () => {
    expect(firstNameFrom("Debra Gallo")).toBe("Debra");
    expect(firstNameFrom("Fryeburg Fair Association")).toBeNull();
    expect(firstNameFrom("info@foo.example")).toBeNull();
    expect(firstNameFrom(null)).toBeNull();
  });
});

describe("one business day", () => {
  const at = (s: string) => contactObligationTarget(new Date(s)).toISOString();

  it("is the end of the next working day in New York", () => {
    // Tue → Wed 23:59 ET (EST, UTC-5).
    expect(at("2026-11-17T16:00:00Z")).toBe("2026-11-19T04:59:00.000Z");
  });

  it("skips the weekend", () => {
    // Fri → Mon. Sat → Mon.
    expect(at("2026-11-13T16:00:00Z")).toBe("2026-11-17T04:59:00.000Z");
    expect(at("2026-11-14T16:00:00Z")).toBe("2026-11-17T04:59:00.000Z");
  });

  it("uses the New York date near midnight UTC", () => {
    // 02:00Z Wed is still Tue evening in New York → due Wed.
    expect(at("2026-11-18T02:00:00Z")).toBe("2026-11-19T04:59:00.000Z");
  });

  it("skips federal holidays, including observed ones", () => {
    expect(isBusinessDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(isBusinessDay("2026-11-27")).toBe(true);
    expect(isBusinessDay("2026-07-03")).toBe(false); // July 4 2026 is a Saturday
    expect(isBusinessDay("2027-12-31")).toBe(false); // Jan 1 2028 is a Saturday
    expect(isBusinessDay("2026-11-11")).toBe(false); // Veterans Day
    // Tue before Veterans Day → Thu, not the Wed holiday.
    expect(at("2026-11-10T16:00:00Z")).toBe("2026-11-13T04:59:00.000Z");
    // Wed before Thanksgiving → Fri.
    expect(at("2026-11-25T16:00:00Z")).toBe("2026-11-28T04:59:00.000Z");
  });
});

/** Run a tool's handler directly: the MCP transport is not what is under test. */
function toolsOf(register: (server: never) => void) {
  const handlers = new Map<
    string,
    (args: never) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >();
  register({
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as never);
    },
  } as never);
  return handlers;
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("closing a contact obligation", () => {
  const admin = { role: "ADMIN", userId: "admin-1" } as never;
  const resolve = (args: Record<string, unknown>) =>
    toolsOf((s) => registerSupportObligationTools(s, db as never, admin)).get(
      "resolve_support_obligation"
    )!(args as never);

  beforeEach(async () => {
    promoter();
    contact("validated");
    inbound("m1");
    await lane("m1", "correction-ack");
  });

  it("refuses every manual close except not_needed with a note", async () => {
    const id = obligations()[0].id;
    for (const status of ["answered", "not_an_obligation", "duplicate"]) {
      const r = await resolve({ id, status, note: "x" });
      expect(r.isError).toBe(true);
    }
    expect(parse(await resolve({ id, status: "not_needed" })).error).toBe("refused");
    expect(obligations()[0].status).toBe("open");
    expect(parse(await resolve({ id, status: "not_needed", note: "answered from Gmail" })).ok).toBe(
      true
    );
    expect(obligations()[0]).toMatchObject({ status: "not_needed" });
  });

  it("not_needed is refused on a support obligation", async () => {
    inbound("m9", { threadId: "other" });
    db.insert(supportObligations)
      .values({
        id: "s1",
        inboundEmailId: "m9",
        fromAddress: "x@y.example",
        openedAt: T,
        status: "open",
      })
      .run();
    const r = await resolve({ id: "s1", status: "not_needed", note: "x" });
    expect(parse(r).error).toBe("refused");
  });

  it("a sent reply closes it, and the send path links the draft to the inbound", async () => {
    expect(shouldCloseOnSend({ source: "operator:outbound", inboundEmailId: "m1" })).toBe(true);
    expect(shouldCloseOnSend({ source: "operator:outbound" })).toBe(false);
    await closeObligationsAnsweredBy(db as never, "m1", "sent");
    expect(obligations()[0].status).toBe("answered");
  });
});

describe("approving a contact draft", () => {
  const admin = { role: "ADMIN", userId: "admin-1" } as never;
  const sent: Record<string, unknown>[] = [];
  const review = (args: Record<string, unknown>) =>
    toolsOf((s) =>
      registerOperatorOutboundTools(s, db as never, admin, {
        OPERATOR_OUTBOUND_ENABLED: "true",
        INTERNAL_API_KEY: "test-signing-key",
        EMAIL_JOBS: { send: async (m: unknown) => void sent.push(m as Record<string, unknown>) },
      })
    ).get("review_operator_draft")!(args as never);

  beforeEach(() => void (sent.length = 0));

  it("sends through the child's parent Message-ID and carries the edited body", async () => {
    promoter();
    contact("validated");
    inbound("parent", { messageId: "<orig@mail>" });
    inbound("child", { parentEmailId: "parent", messageId: null });
    await lane("child", "correction-ack");
    const [d] = drafts();
    expect(d.inboundEmailId).toBe("parent");
    await review({ id: d.id, action: "approve", body_text: "Thanks, Debra. Edited by John." });
    // The reply, plus the operator's BCC copy (OPE-1605).
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      inboundEmailId: "parent",
      inReplyTo: "<orig@mail>",
      references: "<orig@mail>",
      text: "Thanks, Debra. Edited by John.",
      source: "operator:outbound",
    });
    expect(drafts()[0].bodyText).toBe("Thanks, Debra. Edited by John.");
  });

  it("a composed draft with no inbound sends exactly as before", async () => {
    db.insert(operatorOutboundDrafts)
      .values({
        id: "dr-composed",
        toAddress: "a@b.example",
        subject: "Hello there",
        bodyText: "A composed message body.",
        reason: "a reason for sending this",
        composedAt: T,
      })
      .run();
    await review({ id: "dr-composed", action: "approve" });
    expect(sent[0]).toMatchObject({
      to: "a@b.example",
      subject: "Hello there",
      source: "operator:outbound",
    });
    expect(sent[0].inboundEmailId).toBeUndefined();
    expect(sent[0].inReplyTo).toBeUndefined();
    expect(String(sent[0].text)).toContain("A composed message body.");
  });
});

describe("the daily alert", () => {
  it("an obligation past its target gets a line, and one not yet due does not", async () => {
    promoter();
    contact("validated");
    inbound("m1");
    await lane("m1", "correction-ack");
    const target = obligations()[0].targetAt!;

    const before = await readOperatorQueues(db as never, new Date(target.getTime() - 60_000), {});
    expect(before.contactObligationsPastTarget).toBe(0);
    expect(before.lines.join("\n")).not.toContain(DEBRA);

    const after = await readOperatorQueues(db as never, new Date(target.getTime() + 60_000), {});
    expect(after.contactObligationsPastTarget).toBe(1);
    expect(after.lines.join("\n")).toContain(DEBRA);
    expect(after.lines.join("\n")).toContain("OPE-1510");
  });
});

describe("the workflow wiring", () => {
  const wf = readFileSync(join(__dirname, "../src/workflows/inbound-email.ts"), "utf8");

  it("runs after promoter-contact capture and before the send", () => {
    const capture = wf.indexOf('"promoter-contacts/capture"');
    const laneStep = wf.indexOf('"contact-lane",');
    const send = wf.indexOf('"send-reply",\n');
    expect(capture).toBeGreaterThan(0);
    expect(laneStep).toBeGreaterThan(capture);
    expect(send).toBeGreaterThan(laneStep);
  });

  it("a fired lane skips the decision pause, whose reply is automatic", () => {
    expect(wf).toContain("if (!caughtError && needsAdminDecision && !contactLaneFired) {");
  });
});

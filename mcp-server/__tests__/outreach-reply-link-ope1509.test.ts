/**
 * OPE-1509 — the shared reply linker, as the inbound workflow runs it
 * (`promoter-outreach/link-reply`, apply, via 'capture'), against rows shaped
 * exactly as prod stores them: the ledger's provider_message_id carries angle
 * brackets. The earlier fixtures stored bare ids, which is how the Message-ID
 * rule stayed green in tests while matching nothing in prod.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { linkOutreachReplies } from "../src/inbound/outreach-reply-link.js";
import { registerPromoterOutreachMetricsTool } from "../src/tools/admin-promoter-outreach-metrics.js";

const SENT = Math.floor(new Date("2026-10-20T12:38:10Z").getTime() / 1000);
const GOT = SENT + 3600;
const LEDGER_ID = "<w8voNnJbNnXtnpB2iYn87ZeQXp9qzFetTxAX@meetmeatthefair.com>";
const SUBJECT = "America's Hometown Thanksgiving 2026 hours";

let db: TestDb;
let raw: Database.Database;

beforeEach(() => {
  ({ db, raw } = createTestDb());
  raw
    .prepare(
      `INSERT INTO promoter_outreach_attempts
        (id, promoter_id, event_id, to_address, subject, body_text, status, created_at, sent_at)
       VALUES ('cf364db2', 'pr-usa', 'evt-usa', 'info@usathanksgiving.com', ?, 'body', 'sent', ?, ?)`
    )
    .run(SUBJECT, SENT, SENT);
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, provider_message_id)
       VALUES ('4ba0d04a', ?, 'info@usathanksgiving.com', 'email:promoter-outreach', ?)`
    )
    .run(SENT, LEDGER_ID);
});

const inbound = (
  id: string,
  from: string,
  over: { inReplyTo?: string | null; subject?: string; parent?: string | null } = {}
) =>
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, in_reply_to, email_references, parent_email_id, created_at)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', ?, 'correction', ?, ?, ?, ?)`
    )
    .run(
      id,
      GOT,
      from,
      over.subject ?? `Re: ${SUBJECT}`,
      over.inReplyTo === undefined ? LEDGER_ID : over.inReplyTo,
      over.inReplyTo === undefined ? LEDGER_ID : over.inReplyTo,
      over.parent ?? null,
      GOT
    );

const capture = (inboundEmailId: string) =>
  linkOutreachReplies(db, { inboundEmailId, apply: true, actorUserId: null, via: "capture" });

const attempt = () =>
  raw
    .prepare("SELECT status, inbound_email_id FROM promoter_outreach_attempts WHERE id='cf364db2'")
    .get() as { status: string; inbound_email_id: string | null };

const linkAudits = () =>
  raw
    .prepare("SELECT payload_json FROM admin_actions WHERE action='promoter.outreach_replied'")
    .all() as Array<{ payload_json: string }>;

describe("OPE-1509 — capture links a reply with no tool call", () => {
  it("Debra's reply (inbound 0dcec818, another address at the organizer) links on the thread", async () => {
    inbound("0dcec818", "marketing@usathanksgiving.com");
    const r = await capture("0dcec818");
    expect(r.linked).toBe(1);
    expect(r.results[0]).toMatchObject({ verdict: "message_id", attempt_id: "cf364db2" });
    expect(attempt()).toEqual({ status: "replied", inbound_email_id: "0dcec818" });
    expect(JSON.parse(linkAudits()[0].payload_json)).toMatchObject({
      matchedBy: "message_id",
      via: "capture",
    });
  });

  it("with no threading headers, Re: our subject from the organizer's domain links (subject_domain)", async () => {
    inbound("in-2", "marketing@usathanksgiving.com", { inReplyTo: null });
    const r = await capture("in-2");
    expect(r.results[0]).toMatchObject({ verdict: "subject_domain", attempt_id: "cf364db2" });
    expect(attempt().status).toBe("replied");
  });

  it("the same subject from a different domain is NOT linked", async () => {
    inbound("in-3", "someone@otherfair.org", { inReplyTo: null });
    const r = await capture("in-3");
    expect(r.linked).toBe(0);
    expect(attempt().status).toBe("sent");
  });

  it("sibling rows of one email (fan-out children) link ONCE: one transition, one audit row", async () => {
    inbound("parent", "marketing@usathanksgiving.com");
    inbound("child-1", "marketing@usathanksgiving.com", { parent: "parent" });
    inbound("child-2", "marketing@usathanksgiving.com", { parent: "parent" });
    const results = [await capture("parent"), await capture("child-1"), await capture("child-2")];
    expect(results.map((r) => r.linked)).toEqual([1, 0, 0]);
    expect(attempt().inbound_email_id).toBe("parent");
    expect(linkAudits()).toHaveLength(1);
  });

  it("an unrelated inbound with no open ask to match does nothing and does not throw", async () => {
    raw.prepare("UPDATE promoter_outreach_attempts SET status='confirmed'").run();
    inbound("in-4", "someone@example.org", { inReplyTo: null, subject: "Hello" });
    const r = await capture("in-4");
    expect(r).toMatchObject({ linked: 0, open_attempts: 0 });
  });

  it("get_promoter_outreach_metrics counts the capture-linked reply in the funnel", async () => {
    inbound("0dcec818", "marketing@usathanksgiving.com");
    await capture("0dcec818");
    const server = new CapturingMcpServer();
    registerPromoterOutreachMetricsTool(server as never, db, {
      userId: "u",
      role: "ADMIN",
    } as never);
    const res = (await server.invoke("get_promoter_outreach_metrics", {})) as {
      content: Array<{ text: string }>;
    };
    const out = JSON.parse(res.content[0].text);
    expect(out.funnel.replied).toBe(1);
  });
});

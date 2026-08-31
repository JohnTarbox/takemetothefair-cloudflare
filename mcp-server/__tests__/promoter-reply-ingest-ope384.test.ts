/**
 * OPE-384 stage 4 — the two-hop join, exercised end to end.
 *
 * The matching RULES are unit-tested against `linkPromoterReply`. What this
 * file covers is the part that module deliberately cannot know: getting the
 * provider's Message-ID out of `email_send_ledger` and onto the right
 * candidate. `promoter_outreach_attempts.provider_message_id` is never written
 * — the send goes through a queue, so the id only exists later, on the ledger
 * row — and a join that quietly resolved nothing would leave the address rule
 * carrying every match while looking like threading worked.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerPromoterReplyIngestTools } from "../src/tools/admin-promoter-reply-ingest.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
const SENT = Math.floor(new Date("2026-06-01T12:00:00Z").getTime() / 1000);
const GOT = Math.floor(new Date("2026-06-03T09:00:00Z").getTime() / 1000);

let db: TestDb;
let raw: Database.Database;
let server: CapturingMcpServer;

const attempt = (id: string, to: string, eventId: string, status = "sent", sentAt = SENT) =>
  raw
    .prepare(
      `INSERT INTO promoter_outreach_attempts
        (id, promoter_id, event_id, to_address, subject, body_text, status, created_at, sent_at)
       VALUES (?, 'pr1', ?, ?, 'Confirming dates', 'body', ?, ?, ?)`
    )
    .run(id, eventId, to, status, SENT, sentAt);

const ledgerRow = (msgId: string, recipient: string, providerId: string, source: string) =>
  raw
    .prepare(
      `INSERT INTO email_send_ledger (message_id, sent_at, recipient, source, provider_message_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(msgId, SENT, recipient, source, providerId);

const inbound = (id: string, from: string, inReplyTo: string | null, receivedAt = GOT) =>
  raw
    .prepare(
      `INSERT INTO inbound_emails (id, received_at, from_address, to_address, subject, intent, in_reply_to, created_at)
       VALUES (?, ?, ?, 'hello@meetmeatthefair.com', 'Re: Confirming dates', 'reply', ?, ?)`
    )
    .run(id, receivedAt, from, inReplyTo, SENT);

const call = async (args: Record<string, unknown>) => {
  const res = (await server.invoke("link_promoter_reply", args)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text) as {
    linked: number;
    open_attempts: number;
    results: Array<Record<string, unknown>>;
    warning?: string;
  };
};

const statusOf = (id: string) =>
  raw
    .prepare("SELECT status, inbound_email_id FROM promoter_outreach_attempts WHERE id = ?")
    .get(id) as {
    status: string;
    inbound_email_id: string | null;
  };

beforeEach(() => {
  ({ db, raw } = createTestDb());
  server = new CapturingMcpServer();
  registerPromoterReplyIngestTools(server as never, db, ADMIN_AUTH);
});

describe("link_promoter_reply — the ledger hop", () => {
  it("threads on a Message-ID that exists ONLY on the ledger row", async () => {
    // The attempt's own provider_message_id stays NULL, exactly as production
    // leaves it. If the ledger hop is dropped, this reply has a from-address
    // nobody was written to and there is nothing left to match on.
    attempt("a1", "info@grange.org", "evt-1");
    ledgerRow("m1", "info@grange.org", "prov-1", "email:promoter-outreach");
    inbound("in1", "committee-chair@grange.org", "<prov-1>");

    const out = await call({ apply: true });
    expect(out.results[0]).toMatchObject({ verdict: "message_id", attempt_id: "a1" });
    expect(statusOf("a1")).toEqual({ status: "replied", inbound_email_id: "in1" });
  });

  it("ignores ledger rows from a different source", async () => {
    // A vendor digest to the same address must not lend its Message-ID to an
    // outreach ask; source is the only thing separating them.
    attempt("a1", "info@grange.org", "evt-1");
    ledgerRow("m1", "info@grange.org", "prov-1", "email:vendor-digest");
    inbound("in1", "stranger@elsewhere.test", "<prov-1>");

    const out = await call({ apply: true });
    expect(out.results[0]).toMatchObject({ verdict: "none" });
    expect(statusOf("a1").status).toBe("sent");
    expect(out.warning).toMatch(/No provider Message-IDs/);
  });

  it("warns when threading is structurally unavailable", async () => {
    // The failure this catches is silent by nature: with no ledger ids, every
    // match comes from the address rule and the surface still looks healthy.
    attempt("a1", "info@grange.org", "evt-1");
    inbound("in1", "info@grange.org", null);

    const out = await call({ apply: false });
    expect(out.warning).toMatch(/email:promoter-outreach/);
    expect(out.results[0]).toMatchObject({ verdict: "address" });
  });
});

describe("link_promoter_reply — refusals", () => {
  it("does not link a reply from a stranger", async () => {
    attempt("a1", "info@grange.org", "evt-1");
    inbound("in1", "spam@elsewhere.test", null);

    const out = await call({ apply: true });
    expect(out.linked).toBe(0);
    expect(statusOf("a1").status).toBe("sent");
  });

  it("reports ambiguity instead of picking one, and writes nothing", async () => {
    // One organizer, two fairs, one reply. Choosing either would mark an ask
    // answered and let its event leave the queue carrying the other's answer.
    attempt("a1", "info@grange.org", "evt-1");
    attempt("a2", "info@grange.org", "evt-2");
    inbound("in1", "info@grange.org", null);

    const out = await call({ apply: true });
    expect(out.results[0]).toMatchObject({ verdict: "ambiguous" });
    expect(out.linked).toBe(0);
    expect(statusOf("a1").status).toBe("sent");
    expect(statusOf("a2").status).toBe("sent");
  });

  it("lets an operator resolve that ambiguity by naming the attempt", async () => {
    attempt("a1", "info@grange.org", "evt-1");
    attempt("a2", "info@grange.org", "evt-2");
    inbound("in1", "info@grange.org", null);

    await call({ apply: true, inbound_email_id: "in1", attempt_id: "a2" });
    expect(statusOf("a2")).toEqual({ status: "replied", inbound_email_id: "in1" });
    expect(statusOf("a1").status).toBe("sent");
  });

  it("refuses an override that names a CLOSED attempt", async () => {
    // The transition map is enforced here too, so a typo cannot reopen a
    // confirmed ask and re-suppress its event from the queue.
    attempt("a1", "info@grange.org", "evt-1", "confirmed");
    inbound("in1", "info@grange.org", null);

    const out = await call({ apply: true, inbound_email_id: "in1", attempt_id: "a1" });
    // A confirmed attempt is not in the open set at all, so it never becomes a
    // candidate — the override cannot resurrect it.
    expect(out.results[0]).toMatchObject({ verdict: "none" });
    expect(statusOf("a1").status).toBe("confirmed");
  });

  it("writes nothing on a dry run", async () => {
    attempt("a1", "info@grange.org", "evt-1");
    inbound("in1", "info@grange.org", null);

    const out = await call({ apply: false });
    expect(out.results[0]).toMatchObject({ verdict: "address" });
    expect(out.linked).toBe(1);
    expect(statusOf("a1").status).toBe("sent");
  });

  it("does not link a reply older than the ask", async () => {
    attempt("a1", "info@grange.org", "evt-1");
    inbound("in1", "info@grange.org", null, SENT - 3600);

    const out = await call({ apply: true });
    expect(out.linked).toBe(0);
    expect(statusOf("a1").status).toBe("sent");
  });
});

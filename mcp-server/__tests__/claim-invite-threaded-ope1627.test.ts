/**
 * OPE-1627 — create_claim_invite with `in_reply_to_inbound_email_id`: the
 * invite joins the person's own conversation (In-Reply-To / References), its
 * subject defaults to "Re: <theirs>", the primary send is ledgered against the
 * inbound, and the inbound is marked replied — only on a live send.
 *
 * No live sends: EMAIL_JOBS is a capturing mock throughout.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { registerCreateClaimInviteTool, threadingFor } from "../src/tools/admin-claim-invite.js";
import {
  closeNoteForSend,
  shouldCloseOnSend,
  CLAIM_INVITE_SOURCE,
} from "../src/support-obligations-close.js";
import { promoters, claimTokens, adminActions, inboundEmails } from "../src/schema.js";

const ADMIN_AUTH = { userId: "u-admin", role: "ADMIN" as const };
// The real OHTM Message-ID from the ticket's acceptance criterion.
const MSG_ID = "<CAHZYz9x2ySz65ZWp4k9sPztw+w8o=yu-yn0Xr2iPONUs-7wPUA@mail.gmail.com>";

let db: TestDb;
let server: CapturingMcpServer;
let sent: Array<Record<string, string>>;

async function invoke(params: Record<string, unknown>) {
  const res = (await server.invoke("create_claim_invite", params)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { body: JSON.parse(res.content[0].text) as Record<string, unknown>, isError: res.isError };
}

function seedInbound(over: Partial<Record<string, unknown>> = {}) {
  db.insert(inboundEmails)
    .values({
      id: "in-1",
      receivedAt: new Date(),
      fromAddress: "Org.Person@Museum.test",
      toAddress: "submit@meetmeatthefair.com",
      subject: "New Promotor Account",
      intent: "support",
      status: "awaiting_human",
      messageId: MSG_ID,
      createdAt: new Date(),
      ...over,
    } as never)
    .run();
}

const inboundRow = () =>
  db
    .select({ status: inboundEmails.status, replyKind: inboundEmails.replyKind })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, "in-1"))
    .get();

const base = {
  entity_type: "PROMOTER",
  entity_id: "p-1",
  personal_note: "Hi — here is the link to take over your page.",
};

beforeEach(() => {
  ({ db } = createTestDb());
  server = new CapturingMcpServer();
  sent = [];
  registerCreateClaimInviteTool(server as never, db, ADMIN_AUTH, {
    EMAIL_JOBS: { send: async (m: Record<string, string>) => void sent.push(m) },
    INTERNAL_API_KEY: "test-secret",
  } as never);
  db.insert(promoters)
    .values({
      id: "p-1",
      companyName: "Museum Org",
      slug: "museum-org",
      contactEmail: "org.person@museum.test",
      claimed: false,
    })
    .run();
});

describe("OPE-1627 — threaded claim invite", () => {
  it("dry run shows in_reply_to, references and 'Re: <subject>' — and writes nothing", async () => {
    seedInbound();
    const { body, isError } = await invoke({
      ...base,
      dry_run: true,
      in_reply_to_inbound_email_id: "in-1",
    });
    expect(isError).toBeFalsy();
    expect(body.dry_run).toBe(true);
    expect(body.in_reply_to).toBe(MSG_ID);
    expect(body.references).toBe(MSG_ID);
    expect(body.in_reply_to_inbound_email_id).toBe("in-1");
    expect(body.subject).toBe("Re: New Promotor Account");
    expect(sent).toHaveLength(0);
    expect(db.select().from(claimTokens).all()).toHaveLength(0);
    expect(db.select().from(adminActions).all()).toHaveLength(0);
    expect(inboundRow()).toEqual({ status: "awaiting_human", replyKind: null });
  });

  it("live send: headers on BOTH primary and BCC; inbound id on the primary only; inbound marked replied", async () => {
    seedInbound({ emailReferences: "<a@x.test> <b@x.test>" });
    const { body, isError } = await invoke({ ...base, in_reply_to_inbound_email_id: "in-1" });
    expect(isError).toBeFalsy();
    expect(body.created).toBe(true);
    expect(body.inboundMarkedReplied).toBe(true);
    expect(sent).toHaveLength(2);
    const [primary, bcc] = sent;
    const refs = `<a@x.test> <b@x.test> ${MSG_ID}`;
    expect(primary.inReplyTo).toBe(MSG_ID);
    expect(primary.references).toBe(refs);
    expect(primary.inboundEmailId).toBe("in-1");
    expect(primary.subject).toBe("Re: New Promotor Account");
    expect(primary.source).toBe(CLAIM_INVITE_SOURCE);
    expect(bcc.inReplyTo).toBe(MSG_ID);
    expect(bcc.references).toBe(refs);
    expect(bcc.inboundEmailId).toBeUndefined();
    expect(inboundRow()).toEqual({ status: "replied", replyKind: "manual" });
    const [audit] = db.select().from(adminActions).all();
    expect(JSON.parse(audit.payloadJson as string).inReplyToInboundEmailId).toBe("in-1");
  });

  it("an explicit subject wins, and an inbound subject that already starts with Re: gets no second one", async () => {
    seedInbound({ subject: "RE: New Promotor Account" });
    const dry = await invoke({ ...base, dry_run: true, in_reply_to_inbound_email_id: "in-1" });
    expect(dry.body.subject).toBe("RE: New Promotor Account");
    const own = await invoke({
      ...base,
      dry_run: true,
      subject: "Your page",
      in_reply_to_inbound_email_id: "in-1",
    });
    expect(own.body.subject).toBe("Your page");
  });

  it("refuses a sender mismatch — nothing sent, minted or marked", async () => {
    seedInbound({ fromAddress: "someone.else@museum.test" });
    const { body, isError } = await invoke({ ...base, in_reply_to_inbound_email_id: "in-1" });
    expect(isError).toBe(true);
    expect(body.error).toBe("inbound_sender_mismatch");
    expect(sent).toHaveLength(0);
    expect(db.select().from(claimTokens).all()).toHaveLength(0);
    expect(inboundRow()?.status).toBe("awaiting_human");
  });

  it("refuses a missing inbound — on dry run too", async () => {
    for (const dry_run of [false, true]) {
      const { body, isError } = await invoke({
        ...base,
        dry_run,
        in_reply_to_inbound_email_id: "nope",
      });
      expect(isError).toBe(true);
      expect(body.error).toBe("inbound_not_found");
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses an inbound with no Message-ID (no thread to join)", async () => {
    seedInbound({ messageId: null });
    const { body, isError } = await invoke({ ...base, in_reply_to_inbound_email_id: "in-1" });
    expect(isError).toBe(true);
    expect(body.error).toBe("inbound_has_no_message_id");
    expect(sent).toHaveLength(0);
  });

  it("without the input, the messages are exactly today's shape (no threading keys)", async () => {
    seedInbound();
    await invoke(base);
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(Object.keys(m).sort()).toEqual(["from", "html", "source", "subject", "text", "to"]);
    }
    expect(inboundRow()?.status).toBe("awaiting_human");
    const dry = await invoke({ ...base, dry_run: true, resend: true });
    expect(dry.body).not.toHaveProperty("in_reply_to");
    expect(dry.body).not.toHaveProperty("references");
  });
});

describe("OPE-1627 — helpers", () => {
  it("threadingFor does not repeat a Message-ID already last in the chain", () => {
    expect(threadingFor({ messageId: "<m>", emailReferences: "<a> <m>" }).references).toBe(
      "<a> <m>"
    );
    expect(threadingFor({ messageId: "<m>", emailReferences: null })).toEqual({
      inReplyTo: "<m>",
      references: "<m>",
    });
  });

  it("a threaded claim invite closes its obligation on confirmed send; a cold one does not", () => {
    expect(shouldCloseOnSend({ source: CLAIM_INVITE_SOURCE, inboundEmailId: "in-1" })).toBe(true);
    expect(shouldCloseOnSend({ source: CLAIM_INVITE_SOURCE })).toBe(false);
    expect(shouldCloseOnSend({ source: "email:claim-invite-bcc", inboundEmailId: "in-1" })).toBe(
      false
    );
    expect(closeNoteForSend("m-1", null, CLAIM_INVITE_SOURCE)).toContain("create_claim_invite");
  });
});

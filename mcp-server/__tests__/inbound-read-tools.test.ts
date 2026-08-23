import { describe, expect, it, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "./setup-db.js";
import { registerInboundReadTools } from "../src/tools/admin-inbound-read.js";
import { inboundEmails, emailSendLedger } from "../src/schema.js";

/**
 * OPE-499 — the inbound lane's agent read surface.
 *
 * The failure these close: a review of an attachment-bearing submission could
 * read the row the pipeline produced but never the submission itself, so every
 * finding was an inference. These assert the input side is actually retrievable.
 */
function collect() {
  const tools = new Map<string, (args: never) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, cb: (args: never) => Promise<never>) => {
      tools.set(name, cb as never);
    },
  } as never;
  return { server, tools };
}

async function callJson(
  tools: Map<string, (a: never) => Promise<{ content: Array<{ text: string }> }>>,
  name: string,
  args: unknown
) {
  const res = await tools.get(name)!(args as never);
  return JSON.parse(res.content[0].text);
}

describe("inbound read tools (OPE-499)", () => {
  let db: TestDb;
  let tools: ReturnType<typeof collect>["tools"];

  beforeEach(() => {
    ({ db } = createTestDb());
    const c = collect();
    registerInboundReadTools(c.server, db as never, { role: "ADMIN", userId: "u1" } as never);
    tools = c.tools;
  });

  it("registers only READ tools — no writer may join this registrar", () => {
    // Pinned as an exact list on purpose: this registrar is the inbound lane's
    // read surface, and the property worth guarding is that adding a WRITER here
    // fails the build rather than quietly shipping a mutation behind a name that
    // reads like a query. OPE-501 added get_workflow_instance, also read-only;
    // OPE-409 added fetch_inbound_attachment, which streams bytes out and
    // mutates nothing.
    expect([...tools.keys()].sort()).toEqual([
      "fetch_inbound_attachment",
      "get_inbound_email",
      "get_sent_emails",
      "get_workflow_instance",
      "list_inbound_emails",
    ]);
  });

  it("returns the FULL body, not the 500-char excerpt", async () => {
    const full = "x".repeat(2400);
    await db.insert(inboundEmails).values({
      id: "e1",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "someone@example.com",
      toAddress: "submit@meetmeatthefair.com",
      subject: "WM",
      intent: "submit",
      status: "replied",
      bodyTextExcerpt: full.slice(0, 500),
      bodyText: full,
      attachmentCount: 0,
    } as never);

    const out = await callJson(tools, "get_inbound_email", { inbound_email_id: "e1" });
    expect(out.body_text).toHaveLength(2400);
    expect(out.body_text_is_excerpt_only).toBe(false);
  });

  it("says so when only the excerpt exists, rather than passing it off as the body", async () => {
    await db.insert(inboundEmails).values({
      id: "e2",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "a@b.com",
      toAddress: "submit@x",
      intent: "submit",
      status: "received",
      bodyTextExcerpt: "just a preview",
      attachmentCount: 0,
    } as never);
    const out = await callJson(tools, "get_inbound_email", { inbound_email_id: "e2" });
    expect(out.body_text).toBe("just a preview");
    expect(out.body_text_is_excerpt_only).toBe(true);
  });

  it("returns the stored attachment OCR — the flyer's actual text", async () => {
    await db.insert(inboundEmails).values({
      id: "e3",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "a@b.com",
      toAddress: "submit@x",
      intent: "submit",
      status: "replied",
      attachmentCount: 2,
      attachmentOcr: JSON.stringify([
        {
          key: "k1",
          name: "flyer.png",
          chars: 812,
          outcome: "ok:812chars",
          markdown: "# Fall Market\nSept 13, 10-4",
        },
        {
          key: "k2",
          name: "logo.png",
          chars: 4,
          outcome: "under-threshold:4chars",
          markdown: "logo",
        },
      ]),
    } as never);

    const out = await callJson(tools, "get_inbound_email", { inbound_email_id: "e3" });
    expect(out.attachment_ocr).toHaveLength(2);
    expect(out.attachment_ocr[0].markdown).toContain("Sept 13");
    // The one that contributed nothing is STILL listed — "read and useless" must
    // be distinguishable from "never read".
    expect(out.attachment_ocr[1].outcome).toMatch(/under-threshold/);
  });

  it("says the OCR is unrecoverable for a pre-OPE-499 row rather than implying none existed", async () => {
    await db.insert(inboundEmails).values({
      id: "e4",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "a@b.com",
      toAddress: "submit@x",
      intent: "submit",
      status: "replied",
      attachmentCount: 1,
    } as never);
    const out = await callJson(tools, "get_inbound_email", { inbound_email_id: "e4" });
    expect(out.attachment_ocr).toEqual([]);
    // OPE-409 — the assertion changed because the SENTENCE was the defect.
    // The old copy said "it is not recoverable", where "it" scans as the
    // ATTACHMENT; on 2026-08-21 an agent read it that way, declared a fair's
    // poster unreachable and told John so, while the file sat in
    // `attachment_refs` on the same response. So the property now pinned is not
    // "says unrecoverable" but the two that actually matter:
    const note = out.attachment_ocr_note as string;
    // 1. it is explicit that only the TEXT is gone…
    expect(note).toMatch(/no ocr text stored/i);
    // 2. …and it points at the attachment that is still there.
    expect(note).toMatch(/attachment_refs/);
    expect(note).toMatch(/fetch_inbound_attachment/);
    // The old wording must not creep back: no bare "it is not recoverable".
    expect(note).not.toMatch(/\bit is not recoverable\b/i);
  });

  it("warns that parsed_url is singular — the trap that made a 4-URL email look like 1", async () => {
    await db.insert(inboundEmails).values({
      id: "e5",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "a@b.com",
      toAddress: "submit@x",
      intent: "submit",
      status: "replied",
      parsedUrl: "https://example.com/one",
      attachmentCount: 0,
    } as never);
    const out = await callJson(tools, "get_inbound_email", { inbound_email_id: "e5" });
    expect(out.parsed_url).toBe("https://example.com/one");
    expect(out.parsed_url_note).toMatch(/stores ONE url/);
  });

  it("get_sent_emails returns the delivered body for an inbound id", async () => {
    await db.insert(emailSendLedger).values({
      messageId: "m1",
      sentAt: new Date(),
      recipient: "someone@example.com",
      subject: "Thanks for submitting 8 events",
      status: "sent",
      inboundEmailId: "e1",
      bodyText: "Thanks for submitting 8 events",
    } as never);

    const out = await callJson(tools, "get_sent_emails", { inbound_email_id: "e1" });
    expect(out.count).toBe(1);
    // This is the fact OPE-460 is about and could not be checked from MCP.
    expect(out.sent[0].body_text).toContain("8 events");
  });

  it("get_sent_emails REFUSES an unfiltered dump", async () => {
    // Not a convenience guard: an unfiltered read is a bulk export of outside
    // contributors' addresses and correspondence.
    const out = await callJson(tools, "get_sent_emails", {});
    expect(out.error).toBe("filter_required");
  });

  it("list_inbound_emails filters, and flags which rows have stored OCR", async () => {
    await db.insert(inboundEmails).values({
      id: "L1",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "a@b.com",
      toAddress: "submit@x",
      intent: "submit",
      status: "replied",
      attachmentCount: 1,
      attachmentOcr: JSON.stringify([
        { key: "k", name: "f", chars: 9, outcome: "ok:9chars", markdown: "hello" },
      ]),
    } as never);
    await db.insert(inboundEmails).values({
      id: "L2",
      receivedAt: new Date(),
      createdAt: new Date(),
      fromAddress: "c@d.com",
      toAddress: "photos@x",
      intent: "photo_intake",
      status: "received",
      attachmentCount: 0,
    } as never);

    const out = await callJson(tools, "list_inbound_emails", { intent: "submit", limit: 50 });
    expect(out.count).toBeGreaterThan(0);
    expect(out.emails.every((e: { intent: string }) => e.intent === "submit")).toBe(true);
    expect(out.emails.some((e: { has_stored_ocr: boolean }) => e.has_stored_ocr === true)).toBe(
      true
    );
  });

  it("is admin-gated — a non-admin registers nothing", () => {
    const c = collect();
    registerInboundReadTools(c.server, db as never, { role: "VENDOR", userId: "v1" } as never);
    expect(c.tools.size).toBe(0);
  });
});

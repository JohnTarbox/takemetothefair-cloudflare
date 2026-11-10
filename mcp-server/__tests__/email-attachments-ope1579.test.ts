/**
 * OPE-1579 — replies that carry stored files. Real SQL on the producer side;
 * the consumer is driven through sendViaCfEmail with a capturing binding.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CapturingMcpServer, createTestDb, type TestDb } from "./setup-db.js";
import { inboundEmails } from "../src/schema.js";
import { registerAdminTools } from "../src/tools/admin.js";
import { handleReplyToInbound } from "../src/tools/reply-to-inbound-email.js";
import { isPermanentSendError, sendViaCfEmail } from "../src/queue-consumers.js";
import { MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENTS_PER_EMAIL } from "../src/email-attachments.js";
import { media } from "./helpers/magic-bytes.js";

const PDF = new Uint8Array(media("application/pdf", 300) as ArrayBuffer);
const PNG = new Uint8Array(media("image/png", 300) as ArrayBuffer);

function bucketWith(objects: Record<string, Uint8Array>) {
  return {
    get: async (k: string) => {
      const v = objects[k];
      return v ? { arrayBuffer: async () => v.buffer.slice(0) } : null;
    },
  } as unknown as R2Bucket;
}

let db: TestDb;
const queue = () => ({ send: vi.fn(async () => {}) });

async function seed(id: string, refs: unknown[] = []) {
  await db.insert(inboundEmails).values({
    id,
    receivedAt: new Date(),
    fromAddress: "user.alder@example.com",
    toAddress: "support@meetmeatthefair.com",
    subject: "Where is the form?",
    intent: "support",
    status: "received",
    messageId: id === "asker" ? "<q@mail.example.com>" : `<${id}@mail.example.com>`,
    attachmentRefs: JSON.stringify(refs),
    createdAt: new Date(),
  });
}

const ref = (key: string, name: string) => ({ key, name, mimeType: "x/y", size: 1 });
const deps = (q: ReturnType<typeof queue>, bucket?: R2Bucket) => ({
  emailJobs: q,
  replyEnabled: true,
  actorUserId: "admin-1",
  bucket,
});
const reply = (q: ReturnType<typeof queue>, bucket: R2Bucket | undefined, index = 0) =>
  handleReplyToInbound(db, deps(q, bucket), {
    inboundEmailId: "asker",
    body: "Here you go",
    attachments: [{ inbound_email_id: "source", index }],
  });

beforeEach(async () => {
  ({ db } = createTestDb());
  await seed("asker");
});

describe("reply_to_inbound_email attachments (OPE-1579)", () => {
  it("queues a reference, with the threading unchanged and no bytes on the job", async () => {
    await seed("source", [ref("k/app.pdf", "Application.pdf")]);
    const q = queue();

    const res = await reply(q, bucketWith({ "k/app.pdf": PDF }));

    expect(res.ok).toBe(true);
    expect(q.send).toHaveBeenCalledTimes(1);
    const job = (q.send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(job.inReplyTo).toBe("<q@mail.example.com>");
    expect(job.attachments).toEqual([
      { key: "k/app.pdf", filename: "Application.pdf", type: "application/pdf", size: PDF.length },
    ]);
    expect(JSON.stringify(job).length).toBeLessThan(5_000);
  });

  it("a reply with no attachments is byte-for-byte what it was", async () => {
    const q = queue();
    await handleReplyToInbound(db, deps(q), { inboundEmailId: "asker", body: "Hi" });
    const job = (q.send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect("attachments" in job).toBe(false);
  });

  it.each([
    ["a disallowed type", new TextEncoder().encode("<script>x</script>"), /images and PDFs/],
    [
      "an oversized file",
      new Uint8Array(MAX_ATTACHMENT_TOTAL_BYTES + 1).fill(0),
      /images and PDFs|MiB/,
    ],
  ])("refuses %s, sends nothing, and leaves the inbound untouched", async (_l, bytes, msg) => {
    await seed("source", [ref("k/f", "f")]);
    const q = queue();

    const res = await reply(q, bucketWith({ "k/f": bytes as Uint8Array }));

    expect(res).toMatchObject({ ok: false, reason: "attachment_refused" });
    expect(res.ok === false && res.message).toMatch(msg);
    expect(q.send).not.toHaveBeenCalled();
    const [row] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, "asker"));
    expect(row.status).toBe("received");
  });

  it("refuses by total size across files, with a real allowed type", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_TOTAL_BYTES);
    big.set(PDF.subarray(0, 8));
    await seed("source", [ref("a", "a.pdf"), ref("b", "b.pdf")]);
    const q = queue();

    const res = await handleReplyToInbound(db, deps(q, bucketWith({ a: big, b: PDF })), {
      inboundEmailId: "asker",
      body: "x",
      attachments: [
        { inbound_email_id: "source", index: 0 },
        { inbound_email_id: "source", index: 1 },
      ],
    });

    expect(res.ok === false && res.message).toMatch(/MiB/);
    expect(q.send).not.toHaveBeenCalled();
  });

  it("refuses too many, a bad index, an unknown email, and a missing object", async () => {
    await seed("source", [ref("gone", "g.pdf")]);
    const q = queue();
    const bucket = bucketWith({});

    const many = await handleReplyToInbound(db, deps(q, bucket), {
      inboundEmailId: "asker",
      body: "x",
      attachments: Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 1 }, () => ({
        inbound_email_id: "source",
        index: 0,
      })),
    });
    expect(many.ok === false && many.message).toMatch(/At most 10/);
    expect((await reply(q, bucket, 5)).ok).toBe(false);
    expect((await reply(q, bucket, 0)).ok).toBe(false);
    const unknown = await handleReplyToInbound(db, deps(q, bucket), {
      inboundEmailId: "asker",
      body: "x",
      attachments: [{ inbound_email_id: "nope", index: 0 }],
    });
    expect(unknown.ok).toBe(false);
    expect(q.send).not.toHaveBeenCalled();
  });

  it("keeps the suppression check ahead of attachments", async () => {
    await seed("source", [ref("k", "f.pdf")]);
    const { emailSuppressionList } = await import("../src/schema.js");
    await db.insert(emailSuppressionList).values({
      email: "user.alder@example.com",
      reason: "unsubscribe",
      createdAt: new Date(),
    } as never);
    const q = queue();

    const res = await reply(q, bucketWith({ k: PDF }));

    expect(res).toMatchObject({ ok: false, reason: "suppressed" });
    expect(q.send).not.toHaveBeenCalled();
  });

  it("says plainly when the disabled path could not keep the attachments", async () => {
    await seed("source", [ref("k", "f.pdf")]);
    const res = await handleReplyToInbound(
      db,
      { ...deps(queue()), replyEnabled: false },
      {
        inboundEmailId: "asker",
        body: "x",
        attachments: [{ inbound_email_id: "source", index: 0 }],
      }
    );
    expect(res.ok === false && res.message).toContain("does NOT include");
  });
});

describe("reply_to_inbound_email as registered on the Worker (OPE-1579)", () => {
  // The cases above hand the handler a bucket directly, so they stayed green
  // while the registration in admin.ts dropped the binding and production
  // refused every attachment. These go through registerAdminTools.
  const ADMIN = { userId: "admin-1", role: "ADMIN" as const };

  async function invoke(env: Record<string, unknown>) {
    await seed("source", [ref("inbound-attachments/source/form.pdf", "form.pdf")]);
    const server = new CapturingMcpServer();
    registerAdminTools(server as never, db as never, ADMIN, env as never);
    const r = (await server.invoke("reply_to_inbound_email", {
      inbound_email_id: "asker",
      body: "Here is the form.",
      attachments: [{ inbound_email_id: "source", index: 0 }],
    })) as { content: Array<{ text: string }> };
    return JSON.parse(r.content[0].text) as { success: boolean; message?: string };
  }

  it("reaches the Worker's VENDOR_ASSETS and queues the file", async () => {
    const q = queue();
    const out = await invoke({
      EMAIL_JOBS: q,
      EMAIL_REPLY_ENABLED: "true",
      VENDOR_ASSETS: bucketWith({ "inbound-attachments/source/form.pdf": PDF }),
    });

    expect(out.success).toBe(true);
    expect(q.send).toHaveBeenCalledTimes(1);
    const job = (q.send.mock.calls[0] as unknown[])[0] as { attachments: unknown[] };
    expect(job.attachments).toHaveLength(1);
  });

  it("still refuses, and sends nothing, on a Worker with no bucket", async () => {
    const q = queue();
    const out = await invoke({ EMAIL_JOBS: q, EMAIL_REPLY_ENABLED: "true" });

    expect(out.success).toBe(false);
    expect(out.message).toContain("VENDOR_ASSETS binding is not available");
    expect(q.send).not.toHaveBeenCalled();
  });
});

describe("sendViaCfEmail attachments (OPE-1579)", () => {
  const job = {
    to: "user.alder@example.com",
    subject: "s",
    html: "<p>h</p>",
    text: "h",
    source: "reply:manual",
    inReplyTo: "<q@mail.example.com>",
    references: "<q@mail.example.com>",
    attachments: [{ key: "k", filename: "form.png", type: "image/png", size: PNG.length }],
  };

  it("attaches the stored bytes and keeps the thread headers", async () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));

    const res = await sendViaCfEmail(job, { send } as unknown as SendEmail, bucketWith({ k: PNG }));

    expect(res.ok).toBe(true);
    const arg = (send.mock.calls[0] as unknown[])[0] as {
      headers: Record<string, string>;
      attachments: Array<{
        filename: string;
        type: string;
        disposition: string;
        content: ArrayBuffer;
      }>;
    };
    expect(arg.headers["In-Reply-To"]).toBe("<q@mail.example.com>");
    expect(arg.attachments[0]).toMatchObject({
      filename: "form.png",
      type: "image/png",
      disposition: "attachment",
    });
    expect(new Uint8Array(arg.attachments[0].content)).toEqual(PNG);
  });

  it("does not send when the object has gone, and never retries that", async () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));

    const res = await sendViaCfEmail(job, { send } as unknown as SendEmail, bucketWith({}));

    expect(send).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.ok === false && isPermanentSendError(res.error)).toBe(true);
  });

  it("a job with no attachments passes no attachments field", async () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));
    const { attachments: _a, ...plain } = job;
    await sendViaCfEmail(plain, { send } as unknown as SendEmail);
    expect("attachments" in ((send.mock.calls[0] as unknown[])[0] as object)).toBe(false);
  });
});

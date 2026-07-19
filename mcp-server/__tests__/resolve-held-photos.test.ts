/**
 * OPE-254 Defect 2 + rescue — recover held `photo-intake-unresolved` batches.
 *   - threading parse + held-parent lookup
 *   - target-event resolution from a reply (URL / prose name)
 *   - attach + idempotency (resulting_event_id guard)
 *   - the reply→resolve orchestration + trust gate
 */
import { describe, it, expect } from "vitest";
import {
  parseThreadMessageIds,
  findHeldPhotoParents,
  resolveTargetEventFromReply,
  resolveHeldPhotoEmail,
  resolveHeldPhotosFromReply,
} from "../src/photo/resolve-held-photos.js";
import type { Db } from "../src/db.js";
import type { HandlerCtx } from "../src/email-handlers/types.js";
import type { InboundEmail } from "@takemetothefair/db-schema";
import { createTestDb } from "./setup-db.js";
import { events, promoters, inboundEmails } from "../src/schema.js";
import { eq } from "drizzle-orm";

const MSG_A = "<CAEv_qq=MjVUoEfkE52ObrxUUMALZGB@mail.gmail.com>";
const MSG_B = "<CAEv_qq_second_held_msg@mail.gmail.com>";
const SENDER = "jtarboxme@gmail.com";

/** Mock env: R2 returns bytes, main app accepts the upload. */
function mockAttachEnv(opts: { missingObject?: boolean; uploadFails?: boolean } = {}) {
  const uploads: string[] = [];
  return {
    env: {
      VENDOR_ASSETS: {
        get: async (_key: string) =>
          opts.missingObject
            ? null
            : {
                arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
                httpMetadata: { contentType: "image/jpeg" },
              },
      } as unknown as R2Bucket,
      MAIN_APP: {
        fetch: async (req: Request) => {
          uploads.push(req.url);
          return new Response("{}", { status: opts.uploadFails ? 500 : 200 });
        },
      },
      MAIN_APP_URL: "https://app.test",
      INTERNAL_API_KEY: "k",
    },
    uploads,
  };
}

const imageRefsJson = (keys: string[]) =>
  JSON.stringify(
    keys.map((k, i) => ({ key: k, name: `p${i}.jpg`, mimeType: "image/jpeg", size: 10 }))
  );

async function seedEvent(db: Db) {
  await db.insert(promoters).values({
    id: "p1",
    companyName: "Waterford Agricultural Society",
    slug: "waterford-ag" as never,
  } as never);
  await db.insert(events).values({
    id: "evt-waterford",
    name: "Waterford World's Fair",
    slug: "waterford-worlds-fair" as never,
    promoterId: "p1",
    status: "APPROVED",
    startDate: new Date("2026-07-17T00:00:00Z"),
    endDate: new Date("2026-07-19T00:00:00Z"),
  } as never);
}

/** Insert a held photo-intake-unresolved parent row. */
async function seedHeldParent(
  db: Db,
  over: Partial<Record<string, unknown>> = {}
): Promise<string> {
  const id = (over.id as string) ?? crypto.randomUUID();
  await db.insert(inboundEmails).values({
    id,
    receivedAt: new Date(),
    fromAddress: SENDER,
    toAddress: "photos@meetmeatthefair.com",
    intent: "photo_intake",
    status: "replied",
    replyKind: "photo-intake-unresolved",
    resultingEventId: null,
    messageId: MSG_A,
    attachmentRefs: imageRefsJson(["inbound-attachments/g1/a.jpg"]),
    attachmentCount: 1,
    createdAt: new Date(),
    ...over,
  } as never);
  return id;
}

describe("parseThreadMessageIds (OPE-254)", () => {
  it("pulls <ids> from In-Reply-To and References, deduped", () => {
    expect(parseThreadMessageIds(MSG_A, `${MSG_A} ${MSG_B}`)).toEqual([MSG_A, MSG_B]);
  });
  it("returns [] when both headers are null/empty", () => {
    expect(parseThreadMessageIds(null, null)).toEqual([]);
    expect(parseThreadMessageIds("no angle brackets here", "")).toEqual([]);
  });
});

describe("findHeldPhotoParents (OPE-254, real SQLite)", () => {
  it("matches only unresolved held rows from the same sender", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    const MSG_C = "<CAEv_qq_third@mail.gmail.com>";
    const held = await seedHeldParent(d, { id: "held-1", messageId: MSG_A });
    // In the thread but already resolved → excluded by resulting_event_id.
    await seedHeldParent(d, { id: "resolved", messageId: MSG_B, resultingEventId: "x" });
    // In the thread but a different sender → excluded by from_address.
    await seedHeldParent(d, { id: "other", messageId: MSG_C, fromAddress: "someone@else.com" });

    const rows = await findHeldPhotoParents(d, [MSG_A, MSG_B, MSG_C], SENDER);
    expect(rows.map((r) => r.id)).toEqual([held]);
  });
  it("returns [] for no message ids", async () => {
    const { db } = createTestDb();
    expect(await findHeldPhotoParents(db as unknown as Db, [], SENDER)).toEqual([]);
  });
});

describe("resolveTargetEventFromReply (OPE-254, real SQLite)", () => {
  it("resolves a pasted /events/<slug> URL in the body", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    const ev = await resolveTargetEventFromReply(
      d,
      "Re: your message",
      "It's this one: https://meetmeatthefair.com/events/waterford-worlds-fair"
    );
    expect(ev?.id).toBe("evt-waterford");
  });
  it("resolves the fair NAMED in prose", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    const ev = await resolveTargetEventFromReply(
      d,
      "Re: your message",
      "The fair is the Waterford Worlds Fair"
    );
    expect(ev?.id).toBe("evt-waterford");
  });
  it("returns null when nothing names a known fair", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    expect(await resolveTargetEventFromReply(d, "Re: your message", "thanks!")).toBeNull();
  });
});

describe("resolveHeldPhotoEmail (OPE-254)", () => {
  it("attaches photos and marks the row resolved", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    const id = await seedHeldParent(d);
    const { env, uploads } = mockAttachEnv();
    const row = { id, attachmentRefs: imageRefsJson(["k1"]), resultingEventId: null };
    const res = await resolveHeldPhotoEmail(env, d, row, "evt-waterford");
    expect(res).toMatchObject({ attached: 1, failed: 0, skipped: false });
    expect(uploads).toHaveLength(1);
    const [after] = await d.select().from(inboundEmails).where(eq(inboundEmails.id, id));
    expect(after.resultingEventId).toBe("evt-waterford");
  });

  it("skips an already-resolved row (idempotent)", async () => {
    const { db } = createTestDb();
    const { env, uploads } = mockAttachEnv();
    const res = await resolveHeldPhotoEmail(
      env,
      db as unknown as Db,
      { id: "x", attachmentRefs: imageRefsJson(["k1"]), resultingEventId: "already" },
      "evt-waterford"
    );
    expect(res).toMatchObject({ skipped: true, reason: "already-resolved" });
    expect(uploads).toHaveLength(0);
  });

  it("skips a row with no image attachments without marking it resolved", async () => {
    const { db } = createTestDb();
    const { env } = mockAttachEnv();
    const res = await resolveHeldPhotoEmail(
      env,
      db as unknown as Db,
      { id: "x", attachmentRefs: null, resultingEventId: null },
      "evt-waterford"
    );
    expect(res).toMatchObject({ skipped: true, reason: "no-image-attachments" });
  });

  it("leaves the row UNRESOLVED when every attach fails (retryable)", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    const id = await seedHeldParent(d);
    const { env } = mockAttachEnv({ missingObject: true });
    const res = await resolveHeldPhotoEmail(
      env,
      d,
      { id, attachmentRefs: imageRefsJson(["k1"]), resultingEventId: null },
      "evt-waterford"
    );
    expect(res.attached).toBe(0);
    expect(res.skipped).toBe(false);
    const [after] = await d.select().from(inboundEmails).where(eq(inboundEmails.id, id));
    expect(after.resultingEventId).toBeNull();
  });
});

describe("resolveHeldPhotosFromReply (OPE-254)", () => {
  const trusted: HandlerCtx = { sessionId: "wf", senderTrust: "trusted", emailAuth: "pass" };

  const replyRow = (over: Partial<Record<string, unknown>> = {}): InboundEmail =>
    ({
      id: "reply-1",
      fromAddress: SENDER,
      subject: "Re: your message",
      bodyTextExcerpt: "The fair is the Waterford Worlds Fair",
      inReplyTo: MSG_A,
      emailReferences: MSG_A,
      ...over,
    }) as unknown as InboundEmail;

  it("resolves the held batch a trusted reply threads to + names", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    await seedHeldParent(d, { id: "held-1", messageId: MSG_A });
    const { env, uploads } = mockAttachEnv();

    const outcome = await resolveHeldPhotosFromReply(env, d, trusted, replyRow());
    expect(outcome).not.toBeNull();
    expect(outcome!.event.id).toBe("evt-waterford");
    expect(outcome!.resolvedParents).toBe(1);
    expect(outcome!.attached).toBe(1);
    expect(uploads).toHaveLength(1);
    const [after] = await d.select().from(inboundEmails).where(eq(inboundEmails.id, "held-1"));
    expect(after.resultingEventId).toBe("evt-waterford");
  });

  it("returns null for an untrusted sender (falls through to normal correction)", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    await seedHeldParent(d, { id: "held-1", messageId: MSG_A });
    const { env } = mockAttachEnv();
    const untrusted: HandlerCtx = { sessionId: "wf", senderTrust: "unknown", emailAuth: "pass" };
    expect(await resolveHeldPhotosFromReply(env, d, untrusted, replyRow())).toBeNull();
  });

  it("returns null when the reply threads to no held parent", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    const { env } = mockAttachEnv();
    expect(
      await resolveHeldPhotosFromReply(
        env,
        d,
        trusted,
        replyRow({ inReplyTo: MSG_B, emailReferences: MSG_B })
      )
    ).toBeNull();
  });

  it("returns null when threaded but the reply names no known fair", async () => {
    const { db } = createTestDb();
    const d = db as unknown as Db;
    await seedEvent(d);
    await seedHeldParent(d, { id: "held-1", messageId: MSG_A });
    const { env } = mockAttachEnv();
    expect(
      await resolveHeldPhotosFromReply(env, d, trusted, replyRow({ bodyTextExcerpt: "thanks!" }))
    ).toBeNull();
  });
});

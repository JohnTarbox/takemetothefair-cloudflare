/**
 * OPE-1364 — inbound attachments were stored on the public CDN bucket under a
 * key derived from the sender's Message-ID, with the sender's declared MIME
 * type, and the Message-ID dedup ran only AFTER the R2 put. So:
 *
 *  - an `image/svg+xml` part went out as first-party active content;
 *  - a second email reusing a Message-ID overwrote the original's bytes, and
 *    the original row's attachment_refs then served the attacker's file.
 *
 * These pin the three fixes: content sniffing, random never-overwrite keys,
 * and dedup before any write.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureAttachments,
  captureDeliveryAttachments,
  discardStoredAttachments,
  findPriorDeliveryByMessageId,
} from "../src/email-handler.js";
import { sniffAttachmentType } from "../src/attachment-sniff.js";
import { inboundEmails } from "../src/schema.js";
import { createTestDb, type TestDb } from "./setup-db.js";
import { media } from "./helpers/magic-bytes.js";

interface Stored {
  bytes: Uint8Array;
  contentType?: string;
  contentDisposition?: string;
}

/** An in-memory R2 bucket: head / put / get / delete over a Map. */
function memBucket(seed: Record<string, Stored> = {}) {
  const objects = new Map<string, Stored>(Object.entries(seed));
  let puts = 0;
  const bucket = {
    head: async (k: string) => (objects.has(k) ? { key: k } : null),
    put: async (
      k: string,
      v: Uint8Array,
      o?: { httpMetadata?: { contentType?: string; contentDisposition?: string } }
    ) => {
      puts++;
      objects.set(k, {
        bytes: new Uint8Array(v),
        contentType: o?.httpMetadata?.contentType,
        contentDisposition: o?.httpMetadata?.contentDisposition,
      });
      return { key: k };
    },
    get: async (k: string) => objects.get(k) ?? null,
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects, puts: () => puts };
}

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
);

describe("sniffAttachmentType — content decides, not the declared type", () => {
  it.each([
    ["image/jpeg"],
    ["image/png"],
    ["image/gif"],
    ["image/webp"],
    ["image/heic"],
    ["application/pdf"],
  ])("recognises %s by its signature", (mime) => {
    expect(sniffAttachmentType(media(mime, 64))).toBe(mime);
  });

  it("recognises a generic HEIF (mif1, no HEVC brand) as image/heif", () => {
    const b = new Uint8Array(32);
    b.set([0, 0, 0, 20], 0);
    b.set(new TextEncoder().encode("ftypmif1\0\0\0\0mif1"), 4);
    expect(sniffAttachmentType(b)).toBe("image/heif");
  });

  it.each([
    ["SVG", SVG],
    ["SVG with an XML prolog", new TextEncoder().encode('<?xml version="1.0"?><svg/>')],
    ["HTML", new TextEncoder().encode("<!doctype html><script>x</script>")],
    ["TIFF", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])],
    [
      "AVIF (HEIF container, mif1-compatible, not on the list)",
      new Uint8Array([
        0,
        0,
        0,
        24,
        ...new TextEncoder().encode("ftypavif"),
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode("mif1avif"),
      ]),
    ],
    ["filler", new Uint8Array(64).fill(65)],
    ["too short", new Uint8Array([0xff, 0xd8])],
  ])("refuses %s", (_label, bytes) => {
    expect(sniffAttachmentType(bytes)).toBeNull();
  });
});

describe("captureAttachments — sniffed type is what is stored", () => {
  it("SKIPS a real SVG declared image/svg+xml, with a reason, and writes nothing", async () => {
    const { bucket, objects, puts } = memBucket();
    const { refs, skipped } = await captureAttachments(bucket, "g", [
      { filename: "logo.svg", mimeType: "image/svg+xml", content: SVG },
    ]);
    expect(refs).toEqual([]);
    expect(puts()).toBe(0);
    expect(objects.size).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      index: 0,
      name: "logo.svg",
      mimeType: "image/svg+xml", // the DECLARED type, for the diagnosis
      reason: "unrecognized-content",
    });
  });

  it("stores a PNG declared image/svg+xml as image/png, as a download", async () => {
    const { bucket, objects } = memBucket();
    const { refs, skipped } = await captureAttachments(bucket, "g", [
      { filename: "poster.svg", mimeType: "image/svg+xml", content: media("image/png", 200) },
    ]);
    expect(skipped).toEqual([]);
    expect(refs).toHaveLength(1);
    expect(refs[0].mimeType).toBe("image/png");
    const obj = objects.get(refs[0].key)!;
    expect(obj.contentType).toBe("image/png");
    expect(obj.contentDisposition).toBe("attachment");
  });

  it("stores a forwarded message under an inert fixed type", async () => {
    const { bucket, objects } = memBucket();
    const { refs } = await captureAttachments(bucket, "g", [
      {
        filename: "fwd.eml",
        mimeType: "application/octet-stream",
        content: new TextEncoder().encode("From: a@b.c\r\n\r\nbody"),
      },
    ]);
    expect(refs[0].mimeType).toBe("message/rfc822");
    expect(objects.get(refs[0].key)!.contentType).toBe("message/rfc822");
  });

  it("never overwrites: an existing object at the key is left alone and the part is reported", async () => {
    const original = media("image/png", 50);
    const { bucket, objects, puts } = memBucket({
      "inbound-attachments/g/0-a.png": { bytes: original, contentType: "image/png" },
    });
    const { refs, skipped } = await captureAttachments(bucket, "g", [
      { filename: "a.png", mimeType: "image/png", content: media("image/jpeg", 80) },
    ]);
    expect(puts()).toBe(0);
    expect(refs).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["put-failed"]);
    expect(objects.get("inbound-attachments/g/0-a.png")!.bytes).toEqual(original);
  });
});

describe("captureDeliveryAttachments — dedup before any write, random keys", () => {
  let db: TestDb;
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  async function seedRow(messageId: string, refsJson: string) {
    const id = crypto.randomUUID();
    await db.insert(inboundEmails).values({
      id,
      receivedAt: new Date(),
      fromAddress: "organizer@example.com",
      toAddress: "submit@meetmeatthefair.com",
      subject: "poster",
      intent: "submit",
      status: "received",
      workflowInstanceId: null,
      bodyTextExcerpt: null,
      parsedUrl: null,
      attachmentCount: 1,
      attachmentRefs: refsJson,
      rawSize: 1024,
      error: null,
      messageId,
      createdAt: new Date(),
    } as typeof inboundEmails.$inferInsert);
    return id;
  }

  it("a reused Message-ID writes NOTHING and the original bytes are unchanged", async () => {
    const MID = "<CAEv_qq123@mail.gmail.com>";
    const { bucket, objects, puts } = memBucket();

    // The original delivery.
    const first = await captureDeliveryAttachments(db, bucket, MID, [
      { filename: "poster.png", mimeType: "image/png", content: media("image/png", 300) },
    ]);
    if (first.duplicateOf !== null) throw new Error("first delivery must not be a duplicate");
    const originalKey = first.refs[0].key;
    const originalBytes = new Uint8Array(objects.get(originalKey)!.bytes);
    const rowId = await seedRow(MID, JSON.stringify(first.refs));
    expect(puts()).toBe(1);

    // A second email reusing the Message-ID, same index, same filename.
    const second = await captureDeliveryAttachments(db, bucket, MID, [
      { filename: "poster.png", mimeType: "image/png", content: media("image/jpeg", 999) },
    ]);
    expect(second.duplicateOf).toBe(rowId);
    expect(puts()).toBe(1);
    expect(objects.size).toBe(1);
    expect(objects.get(originalKey)!.bytes).toEqual(originalBytes);
  });

  it("keys are random per delivery — never derived from the Message-ID", async () => {
    const { bucket } = memBucket();
    const att = () => [
      { filename: "poster.png", mimeType: "image/png", content: media("image/png", 64) },
    ];
    const a = await captureDeliveryAttachments(db, bucket, "<m1@x>", att());
    const b = await captureDeliveryAttachments(db, bucket, "<m2@x>", att());
    const c = await captureDeliveryAttachments(db, bucket, null, att());
    const keys = [a, b, c].map((r) => (r.duplicateOf === null ? r.refs[0].key : ""));
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) {
      expect(k).toMatch(
        /^inbound-attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/0-poster\.png$/
      );
      expect(k).not.toContain("m1");
      expect(k).not.toContain("m2");
    }
  });

  it("a null Message-ID never dedups (unchanged legacy behaviour)", async () => {
    expect(await findPriorDeliveryByMessageId(db, null)).toBeNull();
  });

  it("a race loser's objects are discarded; the winner's are untouched", async () => {
    const { bucket, objects } = memBucket({
      "inbound-attachments/winner/0-a.png": { bytes: media("image/png", 10) },
      "inbound-attachments/loser/0-a.png": { bytes: media("image/png", 10) },
      "events/x/hero.webp": { bytes: media("image/webp", 10) },
    });
    await discardStoredAttachments(
      bucket,
      JSON.stringify([
        {
          key: "inbound-attachments/loser/0-a.png",
          name: "a.png",
          mimeType: "image/png",
          size: 10,
        },
        // Not ours to delete, even if a ref were tampered.
        { key: "events/x/hero.webp", name: "h", mimeType: "image/webp", size: 10 },
      ])
    );
    expect([...objects.keys()].sort()).toEqual([
      "events/x/hero.webp",
      "inbound-attachments/winner/0-a.png",
    ]);
  });
});
